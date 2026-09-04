/**
 * Take a backup of everything that makes this instance yours, and put it back.
 *
 * In scope: jigs and their active code, whether each schedule is enabled,
 * connections (custom servers, tool permissions, MCP schemas), credentials as
 * ciphertext, settings, and per-jig memory.
 *
 * Out of scope on purpose: run history, logs, step caches, agent sessions and
 * the calendar/reminder fire ledgers. Those describe what the instance has
 * done, not what it is, and carrying them would make a restore look like it
 * had already done work it has not.
 *
 * Version history is also not carried. A restore imports each jig's active
 * code as a single new version, so the archive stays something a person can
 * read and the restore path stays one insert per jig.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  getRawSetting,
  listAllSchedules,
  listJigMemory,
  listRawCredentials,
  listRawSettings,
  listToolPermissions,
  putRawCredential,
  putRawSetting,
  setJigMemory,
  setScheduleEnabled,
  setToolPermission,
  upsertSchedule,
  type ToolPermissionPolicy,
} from "../db.js"
import { CUSTOM_SERVERS_PATH, SCHEMAS_DIR } from "../config/paths.js"
import {
  getActiveCode,
  getJigRow,
  importVersion,
  listJigs,
  setActiveVersion,
} from "../services/jig-store.js"
import type { BackupSnapshot } from "./archive.js"

const SALT_KEY = "password.salt"
const CANARY_KEY = "password.canary"

/**
 * Settings that describe this process rather than this instance's
 * configuration. The crypto pair travels with the credentials instead, and the
 * notify keys are debounce timestamps whose whole purpose is to be stale.
 */
const SETTINGS_NOT_BACKED_UP = [SALT_KEY, CANARY_KEY]
const SETTINGS_PREFIXES_NOT_BACKED_UP = ["system_notify.sent."]

function isBackedUpSetting(key: string): boolean {
  if (SETTINGS_NOT_BACKED_UP.includes(key)) return false
  return !SETTINGS_PREFIXES_NOT_BACKED_UP.some((p) => key.startsWith(p))
}

// ---------------------------------------------------------------------------
// Collect
// ---------------------------------------------------------------------------

export function collectSnapshot(): BackupSnapshot {
  const scheduleByJig = new Map(listAllSchedules().map((s) => [s.jig_id, s]))

  const jigs = listJigs().flatMap((summary) => {
    const row = getJigRow(summary.id)
    const code = getActiveCode(summary.id)
    // A jig with no active version has nothing to restore; skip rather than
    // write an entry whose code file would be missing.
    if (!row || code == null) return []
    return [{ id: row.id, name: row.name, code, createdAt: row.created_at }]
  })

  const schemas: Record<string, string> = {}
  if (existsSync(SCHEMAS_DIR)) {
    for (const file of readdirSync(SCHEMAS_DIR)) {
      if (!file.endsWith(".json")) continue
      schemas[file] = readFileSync(join(SCHEMAS_DIR, file), "utf-8")
    }
  }

  let customServers: Record<string, unknown> = {}
  if (existsSync(CUSTOM_SERVERS_PATH)) {
    try {
      customServers = JSON.parse(readFileSync(CUSTOM_SERVERS_PATH, "utf-8")) as Record<string, unknown>
    } catch {
      customServers = {}
    }
  }

  const settings: Record<string, string> = {}
  for (const { key, value } of listRawSettings()) {
    if (isBackedUpSetting(key)) settings[key] = value
  }

  // Raw, not getSetting: the crypto module writes these as bare strings, so a
  // JSON-decoding read returns null and the archive silently ships encrypted
  // credentials with no way to ever decrypt them.
  const salt = getRawSetting(SALT_KEY)
  const canary = getRawSetting(CANARY_KEY)

  return {
    jigs,
    schedules: jigs.flatMap((j) => {
      const row = scheduleByJig.get(j.id)
      if (!row) return []
      return [{
        jigId: j.id,
        enabled: row.enabled !== 0,
        triggerType: row.trigger_type,
        cronExpr: row.cron_expr ?? null,
        timezone: row.timezone ?? null,
        missedStrategy: row.missed_strategy,
      }]
    }),
    credentials: listRawCredentials().map((c) => ({
      key: c.key,
      value: c.value,
      server: c.server,
      encrypted: c.encrypted !== 0,
    })),
    crypto: salt && canary ? { salt, canary } : null,
    customServers,
    toolPermissions: listToolPermissions().map((p) => ({
      connection: p.connection,
      tool: p.tool,
      policy: p.policy,
    })),
    schemas,
    settings,
    memory: jigs.flatMap((j) =>
      listJigMemory(j.id).map((row) => ({ jigId: j.id, key: row.key, value: row.value })),
    ),
  }
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export interface RestorePlan {
  jigs: { added: string[]; overwritten: string[] }
  credentials: number
  connections: number
  schemas: number
  memory: number
  warnings: string[]
}

/** What a restore would do, computed without touching anything. */
export function planRestore(snapshot: BackupSnapshot): RestorePlan {
  const added: string[] = []
  const overwritten: string[] = []
  for (const jig of snapshot.jigs) {
    (getJigRow(jig.id) ? overwritten : added).push(jig.id)
  }
  return {
    jigs: { added, overwritten },
    credentials: snapshot.credentials.length,
    connections: Object.keys(snapshot.customServers).length,
    schemas: Object.keys(snapshot.schemas).length,
    memory: snapshot.memory.length,
    warnings: credentialWarnings(snapshot),
  }
}

/**
 * Credentials are ciphertext under a key derived from password + salt. Writing
 * them into an instance whose salt differs produces rows that nothing on that
 * instance can decrypt, so the mismatch is reported rather than applied.
 */
function credentialWarnings(snapshot: BackupSnapshot): string[] {
  if (snapshot.credentials.length === 0) return []
  const existingSalt = getRawSetting(SALT_KEY)
  if (!existingSalt || !snapshot.crypto) return []
  if (existingSalt === snapshot.crypto.salt) return []
  return [
    "This instance has a different password than the backup. Its credentials cannot be " +
    "decrypted here, so they were skipped. Restore onto a fresh instance, or pass --force " +
    "to overwrite this instance's password with the backup's.",
  ]
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface RestoreResult extends RestorePlan {
  credentialsSkipped: boolean
}

export function applyRestore(
  snapshot: BackupSnapshot,
  options: { force?: boolean } = {},
): RestoreResult {
  const plan = planRestore(snapshot)
  const skipCredentials = plan.warnings.length > 0 && !options.force

  for (const jig of snapshot.jigs) {
    // Re-importing identical code would stack a new version every restore, so
    // only write one when the active code actually differs.
    if (getActiveCode(jig.id) !== jig.code) {
      const { versionId } = importVersion({
        jigId: jig.id,
        name: jig.name,
        code: jig.code,
        message: "Restored from backup",
        prompt: null,
        parentId: null,
        createdAt: jig.createdAt,
      })
      setActiveVersion(jig.id, versionId)
    }
  }

  // Write the row first, then the flag. The scheduler's sync pass will correct
  // trigger type and cron from the jig source on its next tick, and its upsert
  // leaves `enabled` alone, so a jig restored as disabled stays disabled.
  for (const schedule of snapshot.schedules) {
    upsertSchedule(
      schedule.jigId,
      schedule.triggerType as Parameters<typeof upsertSchedule>[1],
      schedule.cronExpr,
      schedule.missedStrategy as Parameters<typeof upsertSchedule>[3],
      null,
      null,
      schedule.timezone,
    )
    setScheduleEnabled(schedule.jigId, schedule.enabled)
  }

  if (!skipCredentials) {
    for (const cred of snapshot.credentials) {
      putRawCredential({
        key: cred.key,
        value: cred.value,
        server: cred.server,
        encrypted: cred.encrypted ? 1 : 0,
      })
    }
    if (snapshot.crypto) {
      // Verbatim, matching how crypto/password.ts wrote them. JSON-encoding
      // here would store the quotes as part of the salt and no password would
      // ever unlock the restored instance.
      putRawSetting(SALT_KEY, snapshot.crypto.salt)
      putRawSetting(CANARY_KEY, snapshot.crypto.canary)
    }
  }

  for (const [key, value] of Object.entries(snapshot.settings)) {
    if (isBackedUpSetting(key)) putRawSetting(key, value)
  }

  for (const perm of snapshot.toolPermissions) {
    setToolPermission(perm.connection, perm.tool, perm.policy as ToolPermissionPolicy)
  }

  for (const entry of snapshot.memory) {
    setJigMemory(entry.jigId, entry.key, entry.value)
  }

  if (Object.keys(snapshot.schemas).length > 0) {
    mkdirSync(SCHEMAS_DIR, { recursive: true })
    for (const [name, contents] of Object.entries(snapshot.schemas)) {
      // The archive may not be one we wrote, so a name is never trusted to be
      // a bare filename.
      const safe = name.replace(/[^a-zA-Z0-9._-]/g, "_")
      writeFileSync(join(SCHEMAS_DIR, safe), contents)
    }
  }

  if (Object.keys(snapshot.customServers).length > 0) {
    writeFileSync(CUSTOM_SERVERS_PATH, JSON.stringify(snapshot.customServers, null, 2))
  }

  return { ...plan, credentialsSkipped: skipCredentials }
}

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
  setCredential,
} from "../db.js"
import { CUSTOM_SERVERS_PATH, SCHEMAS_DIR } from "../config/paths.js"
import {
  getActiveCode,
  getJigRow,
  importVersion,
  listJigs,
  setActiveVersion,
} from "../services/jig-store.js"
import { decryptWithKey, keyForBackup, WRAPPED_KEY_SETTING } from "../crypto/password.js"
import type { BackupSnapshot } from "./archive.js"

const SALT_KEY = "password.salt"
const CANARY_KEY = "password.canary"

/**
 * Settings that describe one instance rather than the user's configuration:
 * its password and key wrap, its session-signing secret, its health stamp,
 * whether ITS onboarding finished, and the per-jig and per-connection state
 * of incidents and health. Carrying any of these across logs every browser
 * and CLI out of the target, or makes it report another instance's troubles.
 * The crypto pair travels with the credentials instead (see applyRestore).
 * Classify every new settings key here; backup-restore.test.ts pins the list.
 */
const SETTINGS_NOT_BACKED_UP = [SALT_KEY, CANARY_KEY, WRAPPED_KEY_SETTING, "session.hmac_secret", "health.last_check", "onboarding_complete"]
const SETTINGS_PREFIXES_NOT_BACKED_UP = ["system_notify.sent.", "connection_status.", "failure_incident."]

export function isInstanceLocalSetting(key: string): boolean {
  if (SETTINGS_NOT_BACKED_UP.includes(key)) return true
  return SETTINGS_PREFIXES_NOT_BACKED_UP.some((p) => key.startsWith(p))
}

function isBackedUpSetting(key: string): boolean {
  return !isInstanceLocalSetting(key)
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

export const BACKUP_PASSWORD_HINT =
  "This instance has a different password than the backup, so the backup's credentials cannot " +
  "be read here as they are. Give the backup's password to restore them (the field on the " +
  "dashboard, or `jig backup restore --backup-password`); without it they are skipped. This " +
  "instance keeps its own password either way."

/**
 * Credentials are ciphertext under a key derived from password + salt. They
 * copy across as they are only when the salt matches (same key). Otherwise the
 * backup's password is needed to open them, and the restore says so.
 */
function needsBackupPassword(snapshot: BackupSnapshot): boolean {
  if (snapshot.credentials.length === 0 || !snapshot.crypto) return false
  return getRawSetting(SALT_KEY) !== snapshot.crypto.salt
}

function credentialWarnings(snapshot: BackupSnapshot): string[] {
  return needsBackupPassword(snapshot) ? [BACKUP_PASSWORD_HINT] : []
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export interface RestoreResult extends RestorePlan {
  credentialsSkipped: boolean
}

/**
 * Apply a backup. The instance's password is never touched: credentials from
 * a backup under another password are opened with that password (given by the
 * caller) and re-encrypted under this instance's own key, or skipped.
 */
export function applyRestore(
  snapshot: BackupSnapshot,
  options: { backupPassword?: string } = {},
): RestoreResult {
  const plan = planRestore(snapshot)
  const warnings = [...plan.warnings]
  let backupKey: Buffer | null = null
  let skipCredentials = false
  if (needsBackupPassword(snapshot)) {
    backupKey = options.backupPassword && snapshot.crypto
      ? keyForBackup(options.backupPassword, snapshot.crypto.salt, snapshot.crypto.canary)
      : null
    if (backupKey) warnings.length = 0
    else {
      skipCredentials = true
      if (options.backupPassword) warnings.push("The backup password did not match, so its credentials were skipped. This instance's password is unchanged.")
    }
  }

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
    let unreadable = 0
    for (const cred of snapshot.credentials) {
      if (backupKey && cred.encrypted) {
        // Opened with the backup's key, stored under this instance's own
        // (setCredential encrypts when unlocked, plaintext in local mode).
        // A row that will not open (corrupt, or written under yet another
        // key) is skipped and counted; one bad row must not sink the restore.
        let plaintext: string
        try {
          plaintext = decryptWithKey(backupKey, cred.value)
        } catch {
          unreadable++
          continue
        }
        setCredential(cred.key, plaintext, cred.server)
      } else {
        putRawCredential({
          key: cred.key,
          value: cred.value,
          server: cred.server,
          encrypted: cred.encrypted ? 1 : 0,
        })
      }
    }
    if (unreadable > 0) warnings.push(`${unreadable} credential(s) could not be opened with the backup's password and were skipped.`)
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

  return { ...plan, warnings, credentialsSkipped: skipCredentials }
}

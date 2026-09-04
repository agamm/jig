/**
 * The shape of a jig backup: snapshot in, .zip out, and back again.
 *
 * Pure by design. Nothing here reads the database or the filesystem, so the
 * layout is testable on its own and the collection/apply steps (see index.ts)
 * stay separately reviewable.
 *
 * Layout inside the archive:
 *
 *   manifest.json       what this file is, when it was made, what it contains
 *   data.json           jig metadata, schedules, connections, settings, memory
 *   credentials.json    encrypted credential rows plus the salt they need
 *   jigs/<id>.ts        each jig's active code, as readable source
 *   schemas/<name>.json the MCP tool schemas connections are generated from
 *
 * Jig code lives in real .ts files rather than escaped inside data.json so the
 * archive is worth opening: a backup you cannot read is one you cannot trust.
 */
import { createZip, readZip, type ZipEntry } from "./zip.js"

/** Bumped only when an older jig could not correctly read a newer archive. */
export const BACKUP_FORMAT_VERSION = 1

export interface BackupJig {
  id: string
  name: string
  /** Active version's code. History is deliberately not carried, see index.ts. */
  code: string
  createdAt: number
}

/**
 * The schedule row as stored. The scheduler rebuilds trigger type and cron from
 * each jig's source on its next pass, but it only ever UPDATEs an existing row,
 * so a restored instance with no row at all would silently lose a jig that had
 * been switched off. Carrying the whole row means the restore stands on its own.
 */
export interface BackupSchedule {
  jigId: string
  enabled: boolean
  triggerType: string
  cronExpr: string | null
  timezone: string | null
  missedStrategy: string
}

export interface BackupCredential {
  key: string
  /** Stored exactly as the database holds it, ciphertext included. */
  value: string
  server: string
  encrypted: boolean
}

export interface BackupToolPermission {
  connection: string
  tool: string
  policy: string
}

export interface BackupMemoryEntry {
  jigId: string
  key: string
  value: string
}

export interface BackupSnapshot {
  jigs: BackupJig[]
  schedules: BackupSchedule[]
  credentials: BackupCredential[]
  /**
   * Salt and canary from the settings table. Encrypted credentials are useless
   * without the salt, since the key is derived from password + salt. Travels
   * with the credentials and is dropped alongside them.
   */
  crypto: { salt: string; canary: string } | null
  customServers: Record<string, unknown>
  toolPermissions: BackupToolPermission[]
  /** Filename to file contents, e.g. "composio.json". */
  schemas: Record<string, string>
  settings: Record<string, string>
  memory: BackupMemoryEntry[]
}

export interface BackupManifest {
  formatVersion: number
  jigVersion: string
  createdAt: string
  includesCredentials: boolean
  counts: {
    jigs: number
    credentials: number
    connections: number
    schemas: number
    memory: number
  }
}

export interface BuildOptions {
  jigVersion: string
  createdAt: string
  /** Default true. False produces an archive safe to hand to someone else. */
  includeCredentials?: boolean
}

const MANIFEST = "manifest.json"
const DATA = "data.json"
const CREDENTIALS = "credentials.json"
const JIG_PREFIX = "jigs/"
const SCHEMA_PREFIX = "schemas/"

const encode = (value: unknown): Uint8Array =>
  new TextEncoder().encode(JSON.stringify(value, null, 2))
const decode = (data: Uint8Array): string => new TextDecoder().decode(data)

/**
 * Flatten a jig id into a single safe path segment.
 *
 * Restore reads names out of an archive that did not necessarily come from
 * this machine, so an id of "../../etc/passwd" must not be able to steer a
 * write. Everything outside a conservative set becomes an underscore, which
 * also keeps the name usable on every filesystem.
 */
export function entryNameForJig(jigId: string): string {
  return `${JIG_PREFIX}${jigId.replace(/[^a-zA-Z0-9._-]/g, "_")}.ts`
}

export function buildArchive(snapshot: BackupSnapshot, options: BuildOptions): Uint8Array {
  const includeCredentials = options.includeCredentials !== false

  const manifest: BackupManifest = {
    formatVersion: BACKUP_FORMAT_VERSION,
    jigVersion: options.jigVersion,
    createdAt: options.createdAt,
    includesCredentials: includeCredentials,
    counts: {
      jigs: snapshot.jigs.length,
      credentials: includeCredentials ? snapshot.credentials.length : 0,
      connections: Object.keys(snapshot.customServers).length,
      schemas: Object.keys(snapshot.schemas).length,
      memory: snapshot.memory.length,
    },
  }

  // Code is carried in the .ts entries, so it is not repeated here. Two copies
  // of the same source is two chances for them to disagree on restore.
  const data = {
    jigs: snapshot.jigs.map(({ code: _code, ...rest }) => rest),
    schedules: snapshot.schedules,
    customServers: snapshot.customServers,
    toolPermissions: snapshot.toolPermissions,
    settings: snapshot.settings,
    memory: snapshot.memory,
  }

  const entries: ZipEntry[] = [
    { name: MANIFEST, data: encode(manifest) },
    { name: DATA, data: encode(data) },
  ]

  if (includeCredentials) {
    entries.push({
      name: CREDENTIALS,
      data: encode({ crypto: snapshot.crypto, entries: snapshot.credentials }),
    })
  }

  for (const jig of snapshot.jigs) {
    entries.push({ name: entryNameForJig(jig.id), data: new TextEncoder().encode(jig.code) })
  }
  for (const [name, contents] of Object.entries(snapshot.schemas)) {
    entries.push({
      name: `${SCHEMA_PREFIX}${name.replace(/[^a-zA-Z0-9._-]/g, "_")}`,
      data: new TextEncoder().encode(contents),
    })
  }

  return createZip(entries)
}

export function parseArchive(zip: Uint8Array): { manifest: BackupManifest; snapshot: BackupSnapshot } {
  const byName = new Map(readZip(zip).map((e) => [e.name, e.data]))

  const manifestRaw = byName.get(MANIFEST)
  if (!manifestRaw) {
    throw new Error("This zip has no manifest.json, so it is not a jig backup.")
  }
  const manifest = JSON.parse(decode(manifestRaw)) as BackupManifest
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new Error(
      `This backup was written by a newer version of jig (format ${manifest.formatVersion}, ` +
      `this build reads ${BACKUP_FORMAT_VERSION}). Update jig and try again.`
    )
  }

  const dataRaw = byName.get(DATA)
  if (!dataRaw) throw new Error("This backup is missing data.json and cannot be restored.")
  const data = JSON.parse(decode(dataRaw)) as {
    jigs: Omit<BackupJig, "code">[]
    schedules: BackupSchedule[]
    customServers: Record<string, unknown>
    toolPermissions: BackupToolPermission[]
    settings: Record<string, string>
    memory: BackupMemoryEntry[]
  }

  const jigs: BackupJig[] = data.jigs.map((meta) => {
    const codeRaw = byName.get(entryNameForJig(meta.id))
    if (!codeRaw) throw new Error(`Backup is missing the code file for jig "${meta.id}".`)
    return { ...meta, code: decode(codeRaw) }
  })

  const schemas: Record<string, string> = {}
  for (const [name, contents] of byName) {
    if (!name.startsWith(SCHEMA_PREFIX)) continue
    schemas[name.slice(SCHEMA_PREFIX.length)] = decode(contents)
  }

  let credentials: BackupCredential[] = []
  let crypto: BackupSnapshot["crypto"] = null
  const credRaw = byName.get(CREDENTIALS)
  if (credRaw) {
    const parsed = JSON.parse(decode(credRaw)) as {
      crypto: BackupSnapshot["crypto"]
      entries: BackupCredential[]
    }
    credentials = parsed.entries ?? []
    crypto = parsed.crypto ?? null
  }

  return {
    manifest,
    snapshot: {
      jigs,
      schedules: data.schedules ?? [],
      credentials,
      crypto,
      customServers: data.customServers ?? {},
      toolPermissions: data.toolPermissions ?? [],
      schemas,
      settings: data.settings ?? {},
      memory: data.memory ?? [],
    },
  }
}

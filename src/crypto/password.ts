/**
 * System password + credential encryption.
 *
 * One password gates the whole instance. Derives a 256-bit data key via
 * PBKDF2; the key lives in process memory and never on the volume.
 *
 * Without a key in memory jig is "locked": scheduler paused, /api/* returns
 * 423 except /api/health + /api/unlock + /api/setup-password. Two ways out:
 *   - the password (POST /api/unlock), which derives the key again;
 *   - JIG_DATA_KEY, a random instance key `jig deploy` sets as a service
 *     variable. The data key is stored wrapped under it (`key.wrapped`
 *     setting, AES-256-GCM) and unwrapped at boot, so a deploy, update or
 *     crash does not lock the instance. The env is not on the volume and not
 *     in backups, so a stolen volume alone still reveals nothing.
 *
 * Credentials in the `credentials` table are encrypted with the data key
 * (AES-256-GCM with per-row random IV + auth tag). Legacy plaintext rows are
 * encrypted in place the first time a password is set.
 *
 * Node's crypto APIs are used (sync) so existing sync callers of
 * getCredential/setCredential don't need to become async.
 */
import { createCipheriv, createDecipheriv, pbkdf2Sync, randomBytes } from "node:crypto"
import { openDb } from "../db.js"

const SALT_KEY = "password.salt"
const CANARY_KEY = "password.canary"
/** The data key, wrapped under JIG_DATA_KEY. Absent until the first unlock with the variable present. */
export const WRAPPED_KEY_SETTING = "key.wrapped"
export const DATA_KEY_ENV = "JIG_DATA_KEY"
const CANARY_PLAINTEXT = "jig-canary-v1"
const PBKDF2_ITERATIONS = 600_000
const KEY_BYTES = 32
const SALT_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16
const DATA_KEY_HEX = /^[0-9a-f]{64}$/i

export class LockedError extends Error {
  constructor(message = "jig is locked — unlock with password to access credentials") {
    super(message)
    this.name = "LockedError"
  }
}

let dataKey: Buffer | null = null

function getSetting(key: string): string | null {
  const db = openDb()
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined
  return row?.value ?? null
}

function setSetting(key: string, value: string): void {
  const db = openDb()
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
  ).run(key, value)
}

function deleteSetting(key: string): void {
  openDb().prepare(`DELETE FROM settings WHERE key = ?`).run(key)
}

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, "sha256")
}

/** A fresh instance key for JIG_DATA_KEY. */
export function mintDataKey(): string {
  return randomBytes(KEY_BYTES).toString("hex")
}

function parseDataKey(hex: string | undefined): Buffer | null {
  const trimmed = hex?.trim() ?? ""
  return DATA_KEY_HEX.test(trimmed) ? Buffer.from(trimmed, "hex") : null
}

/** Store the data key wrapped under JIG_DATA_KEY; a no-op when the variable is absent or malformed. */
function wrapDataKey(key: Buffer): void {
  const envKey = parseDataKey(process.env[DATA_KEY_ENV])
  if (envKey) setSetting(WRAPPED_KEY_SETTING, encryptWith(envKey, key.toString("hex")))
}

export type AutoUnlockResult = "unlocked" | "no-env-key" | "no-wrapped-key" | "bad-key"

/**
 * Restore the data key from JIG_DATA_KEY and the stored wrap. Called at boot in
 * service mode. Never throws: every outcome is a state the caller reports.
 */
export function tryAutoUnlock(): AutoUnlockResult {
  if (dataKey) return "unlocked"
  const envKey = parseDataKey(process.env[DATA_KEY_ENV])
  if (!envKey) return "no-env-key"
  const wrapped = getSetting(WRAPPED_KEY_SETTING)
  const canary = getSetting(CANARY_KEY)
  if (!wrapped || !canary) return "no-wrapped-key"
  try {
    const key = Buffer.from(decryptWith(envKey, wrapped), "hex")
    // The wrap authenticates under GCM; the canary check also catches a wrap
    // that belongs to another password generation (copied settings rows).
    if (key.length !== KEY_BYTES || decryptWith(key, canary) !== CANARY_PLAINTEXT) return "bad-key"
    dataKey = key
    return "unlocked"
  } catch {
    return "bad-key"
  }
}

/**
 * Ciphertext format: hex(iv) + ":" + hex(ciphertext) + ":" + hex(tag).
 * All three parts are single-line hex so the value stays TEXT-compatible.
 */
function encryptWith(key: Buffer, plaintext: string): string {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv("aes-256-gcm", key, iv)
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()])
  const tag = cipher.getAuthTag()
  return `${iv.toString("hex")}:${ct.toString("hex")}:${tag.toString("hex")}`
}

function decryptWith(key: Buffer, payload: string): string {
  const [ivHex, ctHex, tagHex] = payload.split(":")
  if (!ivHex || !ctHex || !tagHex) throw new Error("Malformed ciphertext")
  const iv = Buffer.from(ivHex, "hex")
  const ct = Buffer.from(ctHex, "hex")
  const tag = Buffer.from(tagHex, "hex")
  if (tag.length !== TAG_BYTES) throw new Error("Malformed auth tag")
  const decipher = createDecipheriv("aes-256-gcm", key, iv)
  decipher.setAuthTag(tag)
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8")
}

/** True when a system password has been set (canary row exists). */
export function isPasswordSet(): boolean {
  return getSetting(CANARY_KEY) !== null && getSetting(SALT_KEY) !== null
}

/** True when the process currently holds the data key in memory. */
export function isUnlocked(): boolean {
  return dataKey !== null
}

/** A deliberate lock: clear the key from memory and drop the wrap, so the next boot stays locked until the password is entered. */
export function lock(): void {
  dataKey = null
  deleteSetting(WRAPPED_KEY_SETTING)
}

/** Test seam: what a process restart does to memory. The wrap stays. */
export function forgetDataKey(): void {
  dataKey = null
}

/**
 * Set the system password for the first time. Fails if a password already
 * exists — rotation is a future-phase operation.
 *
 * Encrypts any existing plaintext credential rows in place, so connections
 * created before a password was set are preserved.
 */
export function setPassword(password: string): void {
  if (isPasswordSet()) {
    throw new Error("A password is already set. Rotation is not yet supported.")
  }
  if (password.length < 8) {
    throw new Error("Password must be at least 8 characters.")
  }
  const salt = randomBytes(SALT_BYTES)
  const key = deriveKey(password, salt)
  const canary = encryptWith(key, CANARY_PLAINTEXT)
  setSetting(SALT_KEY, salt.toString("hex"))
  setSetting(CANARY_KEY, canary)
  wrapDataKey(key)
  dataKey = key

  const db = openDb()
  const rows = db
    .prepare(`SELECT key, value FROM credentials WHERE encrypted = 0`)
    .all() as { key: string; value: string }[]
  for (const row of rows) {
    const ct = encryptWith(key, row.value)
    db.prepare(`UPDATE credentials SET value = ?, encrypted = 1 WHERE key = ?`).run(ct, row.key)
  }
}

/**
 * Rotate the system password. Requires the process to already be unlocked —
 * the in-memory data key IS the proof of the old password. Derives a new key
 * from a fresh salt, re-encrypts every encrypted credential + the canary, then
 * swaps the in-memory key so the running session stays unlocked under the new
 * password.
 *
 * Atomic: if re-encryption fails midway, the DB transaction rolls back and
 * salt/canary remain the old values.
 */
export function changePassword(newPassword: string): void {
  if (!dataKey) throw new LockedError("Unlock with your current password before changing it.")
  if (newPassword.length < 8) {
    throw new Error("Password must be at least 8 characters.")
  }
  const saltHex = getSetting(SALT_KEY)
  const canary = getSetting(CANARY_KEY)
  if (!saltHex || !canary) {
    throw new Error("No password is set. Call setPassword() first.")
  }

  const oldKey = dataKey
  const newSalt = randomBytes(SALT_BYTES)
  const newKey = deriveKey(newPassword, newSalt)
  const newCanary = encryptWith(newKey, CANARY_PLAINTEXT)

  const db = openDb()
  db.exec("BEGIN")
  try {
    const rows = db
      .prepare(`SELECT key, value FROM credentials WHERE encrypted = 1`)
      .all() as { key: string; value: string }[]
    for (const row of rows) {
      const plaintext = decryptWith(oldKey, row.value)
      const ct = encryptWith(newKey, plaintext)
      db.prepare(`UPDATE credentials SET value = ? WHERE key = ?`).run(ct, row.key)
    }
    setSetting(SALT_KEY, newSalt.toString("hex"))
    setSetting(CANARY_KEY, newCanary)
    wrapDataKey(newKey)
    db.exec("COMMIT")
  } catch (e) {
    db.exec("ROLLBACK")
    throw e
  }
  dataKey = newKey
}

/**
 * Try to unlock with the given password. Returns true on success, false if
 * the password is wrong. Throws if no password is set.
 */
export function unlock(password: string): boolean {
  const saltHex = getSetting(SALT_KEY)
  const canary = getSetting(CANARY_KEY)
  if (!saltHex || !canary) {
    throw new Error("No password is set. Call setPassword() first.")
  }
  const key = deriveKey(password, Buffer.from(saltHex, "hex"))
  try {
    const pt = decryptWith(key, canary)
    if (pt !== CANARY_PLAINTEXT) return false
  } catch {
    return false
  }
  wrapDataKey(key)
  dataKey = key
  return true
}

/** Encrypt a value for storage. Throws LockedError if locked. */
export function encrypt(plaintext: string): string {
  if (!dataKey) throw new LockedError()
  return encryptWith(dataKey, plaintext)
}

/** Decrypt a stored value. Throws LockedError if locked. */
export function decrypt(ciphertext: string): string {
  if (!dataKey) throw new LockedError()
  return decryptWith(dataKey, ciphertext)
}

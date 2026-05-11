/**
 * System password + credential encryption.
 *
 * One password gates the whole instance. Derives a 256-bit key via PBKDF2;
 * the key lives only in process memory (never on disk, never in env).
 *
 * On boot, jig is "locked": the key is absent, scheduler paused, /api/* returns
 * 423 except /api/health + /api/unlock + /api/setup-password. After unlock, the
 * key is restored and normal operation resumes. A service restart re-locks.
 *
 * Credentials in the `credentials` table are encrypted with this key
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
const CANARY_PLAINTEXT = "jig-canary-v1"
const PBKDF2_ITERATIONS = 600_000
const KEY_BYTES = 32
const SALT_BYTES = 32
const IV_BYTES = 12
const TAG_BYTES = 16

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

function deriveKey(password: string, salt: Buffer): Buffer {
  return pbkdf2Sync(password, salt, PBKDF2_ITERATIONS, KEY_BYTES, "sha256")
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

/** Clear the in-memory key. Called on manual lock or process exit. */
export function lock(): void {
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

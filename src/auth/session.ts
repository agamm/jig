/**
 * Session cookie for dashboard authentication.
 *
 * One password gates the whole instance. Users prove knowledge of the
 * password by POSTing /api/unlock; on success they receive a signed cookie
 * that authorizes subsequent /api/* requests.
 *
 * The HMAC secret is generated on first boot and stored in settings —
 * it does NOT need to be secret-at-rest because anyone who can read the DB
 * can already read the encrypted credentials. Its purpose is only to stop
 * tampering with cookie expiry from untrusted clients.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto"
import { openDb } from "../db.js"

const SESSION_SECRET_KEY = "session.hmac_secret"
const COOKIE_NAME = "jig-admin"
const COOKIE_TTL_SECONDS = 30 * 24 * 60 * 60 // 30 days

function getOrCreateSecret(): string {
  const db = openDb()
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(SESSION_SECRET_KEY) as
    | { value: string }
    | undefined
  if (row?.value) return row.value
  const secret = randomBytes(32).toString("hex")
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(SESSION_SECRET_KEY, secret)
  return secret
}

function sign(payload: string): string {
  return createHmac("sha256", getOrCreateSecret()).update(payload).digest("hex")
}

/** Build a signed session token `<issuedAt>.<expiresAt>.<sig>`. */
export function issueToken(): string {
  const now = Math.floor(Date.now() / 1000)
  const exp = now + COOKIE_TTL_SECONDS
  const payload = `${now}.${exp}`
  return `${payload}.${sign(payload)}`
}

/** Verify a session token. Returns true if the signature is valid and not expired. */
export function verifyToken(token: string | undefined): boolean {
  if (!token) return false
  const parts = token.split(".")
  if (parts.length !== 3) return false
  const [issuedAtStr, expStr, sig] = parts
  const payload = `${issuedAtStr}.${expStr}`
  const expected = sign(payload)
  if (sig.length !== expected.length) return false
  if (!timingSafeEqual(Buffer.from(sig, "hex"), Buffer.from(expected, "hex"))) return false
  const exp = parseInt(expStr, 10)
  if (!Number.isFinite(exp)) return false
  if (exp < Math.floor(Date.now() / 1000)) return false
  return true
}

/** Extract the session cookie value from a Cookie header string. */
export function parseSessionCookie(cookieHeader: string | null): string | undefined {
  if (!cookieHeader) return undefined
  for (const part of cookieHeader.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=")
    if (rawKey === COOKIE_NAME) return rest.join("=")
  }
  return undefined
}

/** Produce a Set-Cookie header value for the given signed token. */
export function setCookieHeader(token: string): string {
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    `Max-Age=${COOKIE_TTL_SECONDS}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
  ]
  return attrs.join("; ")
}

/** Produce a Set-Cookie header that clears the session. */
export function clearCookieHeader(): string {
  return `${COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`
}

export const SESSION_COOKIE_NAME = COOKIE_NAME

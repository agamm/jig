import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from "fs"
import { join } from "path"
import { timingSafeEqual } from "node:crypto"
import { PROJECT_ROOT } from "../config/paths.js"

const SECRET_PATH = join(PROJECT_ROOT, ".jig", "webhook-secret")

function getServerSecret(): string {
  if (existsSync(SECRET_PATH)) {
    // Remediate secrets written before we set restrictive perms (existing
    // installs, incl. deployed ones, self-heal to 0600 on next boot).
    try { chmodSync(SECRET_PATH, 0o600) } catch { /* best-effort */ }
    return readFileSync(SECRET_PATH, "utf-8").trim()
  }
  const secret = crypto.randomUUID()
  // This is the master HMAC key behind every per-jig webhook token — anyone
  // who can read it can forge a valid token for any jig and trigger runs.
  // Keep it owner-only (dir 0700, file 0600).
  mkdirSync(join(PROJECT_ROOT, ".jig"), { recursive: true, mode: 0o700 })
  writeFileSync(SECRET_PATH, secret, { mode: 0o600 })
  return secret
}

let _secret: string | null = null

export function webhookToken(jigId: string): string {
  if (!_secret) _secret = getServerSecret()
  const hmac = new Bun.CryptoHasher("sha256")
  hmac.update(_secret + ":" + jigId)
  return hmac.digest("hex").slice(0, 32)
}

export function validateWebhookToken(jigId: string, token: string): boolean {
  const expected = webhookToken(jigId)
  // Constant-time compare so a network attacker can't recover the token
  // byte-by-byte from response timing. Guard length first — timingSafeEqual
  // throws on a length mismatch.
  const a = Buffer.from(token)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

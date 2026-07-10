/**
 * One-time setup code — closes the first-boot takeover race.
 *
 * On an internet-exposed (service-mode) instance, POST /api/setup-password must
 * be public: it bootstraps the very first credential, so it can't sit behind
 * the session gate. Without a second factor, whoever reaches the URL first
 * claims the instance and locks out the real owner (setPassword refuses to
 * overwrite). This module mints a high-entropy code at boot and prints it
 * ONLY to the server logs — which the real operator reads via `railway logs` /
 * the container console, but a network attacker cannot. Setup then requires
 * that code. The code lives in memory only (never DB/disk beyond the log line)
 * and is cleared the moment a password is set.
 *
 * Scope: service mode only. Local mode binds loopback with no password concept,
 * so there's no remote race to defend against there.
 */
import { randomBytes, timingSafeEqual } from "node:crypto"

// Crockford-style base32 minus ambiguous glyphs (no I/L/O/U/0/1) so the code
// is safe to read off a log line and retype. 12 chars ≈ 59 bits — far past any
// online-guessing threat, and short enough to copy by hand.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
const CODE_LEN = 12

let setupCode: string | null = null
let announced = false

function mint(): string {
  const bytes = randomBytes(CODE_LEN)
  let out = ""
  for (let i = 0; i < CODE_LEN; i++) {
    out += ALPHABET[bytes[i] % ALPHABET.length]
    if (i % 4 === 3 && i < CODE_LEN - 1) out += "-" // ABCD-EFGH-JKMN
  }
  return out
}

/** Strip separators/case so "abcd efgh", "ABCD-EFGH", "abcdefgh" all compare equal. */
function normalize(s: string): string {
  return s.replace(/[^0-9A-Za-z]/g, "").toUpperCase()
}

/** Lazily mint (once per process) and return the in-memory setup code. */
export function getSetupCode(): string {
  if (!setupCode) setupCode = mint()
  return setupCode
}

/** Print the code to the server logs so the operator can claim the instance. Idempotent per process. */
export function announceSetupCode(): void {
  if (announced) return
  announced = true
  const code = getSetupCode()
  const bar = "─".repeat(56)
  console.log(
    `\n${bar}\n` +
      `  This jig instance is unclaimed.\n` +
      `  Set your admin password on the dashboard using this code:\n\n` +
      `      SETUP CODE:  ${code}\n\n` +
      `  It appears only here in the logs. Anyone who has it can\n` +
      `  claim this instance, so don't share it.\n${bar}\n`,
  )
}

/** Timing-safe check of a caller-supplied code against the in-memory code. */
export function verifySetupCode(provided: string | undefined | null): boolean {
  if (!provided || !setupCode) return false
  const a = Buffer.from(normalize(provided))
  const b = Buffer.from(normalize(setupCode))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Clear the code once the password is set — it's single-use. */
export function clearSetupCode(): void {
  setupCode = null
  announced = false
}

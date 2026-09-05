/**
 * One-time setup code — closes the first-boot takeover race.
 *
 * On an internet-exposed (service-mode) instance, POST /api/setup-password must
 * be public: it bootstraps the very first credential, so it can't sit behind
 * the session gate. Without a second factor, whoever reaches the URL first
 * claims the instance and locks out the real owner (setPassword refuses to
 * overwrite). This module holds a high-entropy code that only the operator
 * knows: the deployer passes one in as JIG_SETUP_CODE (so the CLI that created
 * the service can print it), otherwise one is minted at boot and printed ONLY
 * to the server logs. Setup then requires that code. The code lives in memory
 * only and is retired the moment a password is set.
 *
 * After the password is set, the same code buys exactly one CLI session within
 * a day (see claimSetupCodePairing). Whoever held the code could have claimed
 * the whole instance, so this grants nothing new; it lets the machine that
 * deployed pair itself without a pasted pairing code.
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
const PAIRING_GRACE_MS = 24 * 60 * 60_000

let setupCode: string | null = null
let announced = false
/** Once the password is set, the retired code can pair one CLI session for a while. */
let pairingBootstrap: { code: string; expiresAt: number } | null = null

/** ABCD-EFGH-JKMN from the bare 12 characters. */
export function formatSetupCode(normalized: string): string {
  return normalized.match(/.{1,4}/g)?.join("-") ?? normalized
}

/** A fresh code in display form. Exported so the deploying CLI can choose one up front. */
export function mintSetupCode(): string {
  const bytes = randomBytes(CODE_LEN)
  let out = ""
  for (let i = 0; i < CODE_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return formatSetupCode(out)
}

/** Strip separators/case so "abcd efgh", "ABCD-EFGH", "abcdefgh" all compare equal. */
function normalize(s: string): string {
  return s.replace(/[^0-9A-Za-z]/g, "").toUpperCase()
}

function isWellFormed(normalized: string): boolean {
  return normalized.length === CODE_LEN && [...normalized].every((c) => ALPHABET.includes(c))
}

/** The code from the environment when the deployer set one, else lazily minted once per process. */
export function getSetupCode(): string {
  if (setupCode) return setupCode
  const fromEnv = normalize(process.env.JIG_SETUP_CODE ?? "")
  setupCode = isWellFormed(fromEnv) ? formatSetupCode(fromEnv) : mintSetupCode()
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

function sameCode(provided: string, expected: string): boolean {
  const a = Buffer.from(normalize(provided))
  const b = Buffer.from(normalize(expected))
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** Timing-safe check of a caller-supplied code against the in-memory code. */
export function verifySetupCode(provided: string | undefined | null): boolean {
  if (!provided || !setupCode) return false
  return sameCode(provided, setupCode)
}

/** Retire the code once the password is set; keep it as a one-shot pairing ticket for a day. */
export function clearSetupCode(): void {
  if (setupCode) pairingBootstrap = { code: setupCode, expiresAt: Date.now() + PAIRING_GRACE_MS }
  setupCode = null
  announced = false
}

/** Redeem the retired setup code for one CLI session. Single use, and only after the password exists. */
export function claimSetupCodePairing(provided: string | undefined | null): boolean {
  if (!provided || !pairingBootstrap) return false
  if (Date.now() > pairingBootstrap.expiresAt) {
    pairingBootstrap = null
    return false
  }
  if (!sameCode(provided, pairingBootstrap.code)) return false
  pairingBootstrap = null
  return true
}

/** Test seam: forget every code. */
export function resetSetupCodeState(): void {
  setupCode = null
  announced = false
  pairingBootstrap = null
}

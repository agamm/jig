/**
 * One-time codes that let a CLI (or a coding agent driving one) cache an admin
 * session without ever seeing the instance password.
 *
 * The problem this solves: `jig deploy` writes a remote manifest with no session
 * cookie, because the password is set later in a browser. Caching a session then
 * meant typing the password at a terminal, which is exactly the thing you cannot
 * paste into a chat with an agent. A code is safe to paste: it is single use,
 * expires in minutes, and grants only what a session already grants.
 *
 * Kept in memory on purpose. A restart invalidates every outstanding code, which
 * is the right failure direction, and nothing durable is worth writing for a
 * value that lives ten minutes.
 */
import { randomBytes } from "node:crypto"

const TTL_MS = 10 * 60_000

/** Entropy over brevity: the claim endpoint is public, and this gets pasted, not typed. */
const CODE_BYTES = 24

type Pending = { code: string; expiresAt: number }

let pending: Pending | null = null
/** When a code was last redeemed, so the page that minted it can say "done". */
let claimedAt: number | null = null

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/**
 * Mint a code, replacing any outstanding one. There is a single admin, so a
 * second request is a retry rather than a parallel pairing, and leaving the old
 * one live would only widen the window.
 */
export function mintPairingCode(): { code: string; expiresInS: number } {
  const code = base64url(randomBytes(CODE_BYTES))
  pending = { code, expiresAt: Date.now() + TTL_MS }
  claimedAt = null // a fresh code is a fresh question, not a stale yes
  return { code, expiresInS: Math.floor(TTL_MS / 1000) }
}

/**
 * Redeem a code. Single use: valid or not, the outstanding code is cleared when
 * it matches, so a replay of a leaked paste finds nothing.
 */
export function claimPairingCode(code: string): boolean {
  const outstanding = pending
  if (!outstanding) return false
  if (Date.now() > outstanding.expiresAt) {
    pending = null
    return false
  }
  // Length-independent compare is overkill here (the code is high-entropy and
  // single-use) but constant-time is free with a fixed-length string.
  if (code.length !== outstanding.code.length) return false
  let diff = 0
  for (let i = 0; i < code.length; i++) diff |= code.charCodeAt(i) ^ outstanding.code.charCodeAt(i)
  if (diff !== 0) return false

  pending = null
  claimedAt = Date.now()
  return true
}

/** A CLI paired through another door (the deploy-time setup code); the Setup page should still say so. */
export function markPairingClaimed(): void {
  claimedAt = Date.now()
}

/** For the page that minted the code: has a CLI redeemed it yet? */
export function getPairingStatus(): { outstanding: boolean; claimed: boolean } {
  const live = pending !== null && Date.now() <= pending.expiresAt
  return { outstanding: live, claimed: claimedAt !== null }
}

/** Test seam. */
export function resetPairingCodes(): void {
  pending = null
  claimedAt = null
}

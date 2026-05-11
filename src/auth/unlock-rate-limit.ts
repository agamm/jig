/**
 * Brute-force defense for /api/unlock.
 *
 * Simple per-IP cliff lockout. After MAX_FAILS failures in the rolling
 * window, the IP is rejected for LOCKOUT_1 ms. A repeat offence inside
 * the window doubles the penalty (LOCKOUT_2). Success clears the IP.
 *
 * Why no rate-limit on concurrent derivations or sliding-window tokens:
 * PBKDF2 at 600k rounds already costs ~250ms/derivation on Railway's
 * shared CPU. A single attacker from one IP is rate-limited by the
 * cliff; a distributed attack would need 10k+ IPs to work around the
 * cliff, and at that scale the attacker can afford a real password
 * brute-force infra anyway — adding a global semaphore mainly just
 * creates a DoS vector against the legitimate operator.
 *
 * State is in-memory; a redeploy resets it. That's fine — attackers
 * restart too, and no legit user relies on rate-limit persistence.
 */

const MAX_FAILS = 5
const WINDOW_MS = 10 * 60_000        // fails older than this stop counting
const LOCKOUT_1 = 60_000              // first offense
const LOCKOUT_2 = 10 * 60_000         // escalated
const PRUNE_INTERVAL_MS = 5 * 60_000  // periodically drop stale entries

type Entry = {
  fails: number
  firstFailAt: number
  lockedUntil: number
  escalated: boolean
}

const attempts = new Map<string, Entry>()

function pruneExpired(): void {
  const now = Date.now()
  for (const [ip, e] of attempts) {
    if (e.lockedUntil <= now && (now - e.firstFailAt) > WINDOW_MS) {
      attempts.delete(ip)
    }
  }
}
setInterval(pruneExpired, PRUNE_INTERVAL_MS).unref?.()

export type LimitCheck =
  | { ok: true }
  | { ok: false; retryAfterS: number }

/** Consult the per-IP counter. Does NOT mutate state. */
export function checkUnlockLimit(ip: string): LimitCheck {
  const now = Date.now()
  const e = attempts.get(ip)
  if (!e) return { ok: true }
  if (e.lockedUntil > now) {
    return { ok: false, retryAfterS: Math.ceil((e.lockedUntil - now) / 1000) }
  }
  if (now - e.firstFailAt > WINDOW_MS) {
    attempts.delete(ip)
  }
  return { ok: true }
}

/** Record a failed unlock. Triggers lockout after MAX_FAILS. */
export function recordUnlockFailure(ip: string): void {
  const now = Date.now()
  const prior = attempts.get(ip)
  const e: Entry = prior ?? { fails: 0, firstFailAt: now, lockedUntil: 0, escalated: false }
  if (!prior) e.firstFailAt = now
  e.fails++
  if (e.fails >= MAX_FAILS) {
    e.lockedUntil = now + (e.escalated ? LOCKOUT_2 : LOCKOUT_1)
    e.escalated = true
    e.fails = 0
    e.firstFailAt = now
  }
  attempts.set(ip, e)
}

/** Clear the IP's counter. Called on successful unlock. */
export function recordUnlockSuccess(ip: string): void {
  attempts.delete(ip)
}

/**
 * Extract the client IP behind Railway's edge.
 *
 * Railway appends the real client IP to X-Forwarded-For. Attackers can
 * spoof LEFT entries; they can't strip what the edge adds on the RIGHT.
 * So the rightmost entry is the only trustworthy one behind a single-hop
 * proxy like Railway. Off-Railway deployments behind a different proxy
 * topology would need this rethought.
 */
export function clientIpFromRequest(req: Request): string {
  const xff = req.headers.get("x-forwarded-for")
  if (!xff) return "unknown"
  const parts = xff.split(",").map((s) => s.trim()).filter(Boolean)
  return parts[parts.length - 1] || "unknown"
}

/**
 * Lock + auth gate for /api/* in service mode.
 *
 * Two orthogonal gates:
 *   1. **Locked state** — no in-memory crypto key ⇒ can't decrypt credentials.
 *      Until the first user POSTs /api/unlock (or /api/setup-password on a
 *      fresh install), every /api/* request except a small allow-list returns
 *      423 Locked.
 *   2. **Session auth** — even after the process is unlocked, anonymous
 *      requests are rejected with 401. A valid signed cookie (issued at
 *      /api/unlock success) authorizes subsequent calls.
 *
 * Local mode is not gated — `jig start` on a developer laptop preserves its
 * current zero-friction behavior.
 */
import { isServiceMode } from "../config/runtime.js"
import { isPasswordSet, isUnlocked } from "../crypto/password.js"
import { parseSessionCookie, verifyToken } from "./session.js"
import { json } from "../server/http.js"

/** Route handler names that are reachable without auth. */
const PUBLIC_HANDLERS = new Set<string>([
  "health",
  "unlock",
  "setupPassword",
  "oauthCallback",
  "webhook", // external webhook triggers carry their own per-jig token
])

/**
 * Apply the gate for a given incoming request + matched handler.
 * Returns a Response to short-circuit, or null to let the handler run.
 */
export function checkAccess(req: Request, handler: string): Response | null {
  if (!isServiceMode()) return null
  if (PUBLIC_HANDLERS.has(handler)) return null

  if (isPasswordSet() && !isUnlocked()) {
    return json({ error: "Locked. Unlock with your password to continue.", locked: true }, 423)
  }

  if (!isPasswordSet()) {
    return json({ error: "No password set yet. Visit the dashboard to set one.", setup: true }, 423)
  }

  const cookie = parseSessionCookie(req.headers.get("cookie"))
  if (!verifyToken(cookie)) {
    return json({ error: "Unauthorized" }, 401)
  }

  return null
}

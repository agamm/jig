/**
 * Instance access: health, first-boot claim, unlock, password change, and the
 * OAuth callback landing page.
 *
 * These are the routes that run BEFORE the instance is usable, so they are also
 * the ones `lock-middleware.ts` lets through unauthenticated (see
 * PUBLIC_HANDLERS). Keep that list and this module in agreement.
 */
import { openDb, getCredential, setCredential } from "../../db.js"
import { apiJson, apiJsonWithHeaders, json } from "../http.js"
import { isServiceMode, publicUrl } from "../../config/runtime.js"
import { changePassword, isPasswordSet, isUnlocked, setPassword, unlock } from "../../crypto/password.js"
import { checkAccess } from "../../auth/lock-middleware.js"
import { issueToken, setCookieHeader } from "../../auth/session.js"
import { clearSetupCode, verifySetupCode } from "../../auth/setup-code.js"
import {
  checkUnlockLimit,
  clientIpFromRequest,
  recordUnlockFailure,
  recordUnlockSuccess,
} from "../../auth/unlock-rate-limit.js"
import { completePendingOAuth, completePendingOAuthStateless, renderOAuthErrorPage, renderOAuthSuccessPage } from "../../mcp/auth.js"
import { getDataStorageHealth } from "../../services/data-storage.js"
import { getSchedulerHealth } from "../../scheduler/index.js"
import { canSendAgentMail } from "../../services/agentmail.js"

function isOnboardingComplete(): boolean {
  const db = openDb()
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get("onboarding_complete") as
    | { value: string }
    | undefined
  return row?.value === "true"
}

function markOnboardingComplete(): void {
  const db = openDb()
  db.prepare(
    `INSERT INTO settings (key, value) VALUES (?, 'true')
     ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = datetime('now')`,
  ).run("onboarding_complete")
}

function hasOpenRouterKey(): boolean {
  if (!isUnlocked()) return false
  try {
    return !!getCredential("openrouter:api_key")
  } catch {
    return false
  }
}

function isDbWritable(): boolean {
  try {
    const db = openDb()
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('health.last_check', ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    ).run(JSON.stringify(Date.now()))
    return true
  } catch {
    return false
  }
}

/** Runs stuck in 'running' for over 2h — should be 0 with the run watchdog on. */
function countStalledRuns(): number {
  try {
    const row = openDb().prepare(
      `SELECT COUNT(*) AS n FROM runs WHERE status = 'running' AND started_at < datetime('now', '-2 hours')`,
    ).get() as { n: number } | null
    return row?.n ?? 0
  } catch {
    return 0
  }
}

export async function handleHealth(req: Request, version: string, startedAt: number): Promise<Response> {
  // `health` is the only /api/* route that's reachable without auth in service
  // mode — the dashboard calls it to decide which onboarding screen to show.
  // Only emit the fields UnlockGate actually needs there; put admin-only fields
  // (uptime, has-key) behind auth so an unauthenticated attacker can't
  // fingerprint the instance's OpenRouter state or last restart time.
  const authed = !isServiceMode() || checkAccess(req, "serverLogs") === null
  const base = {
    version,
    mode: isServiceMode() ? "service" as const : "local" as const,
    public_url: publicUrl() ?? null,
    // In service mode, "locked" means credentials are unreachable — whether
    // because no password has been set yet OR because the key isn't in memory.
    // UnlockGate uses this to decide between the set-password form, the unlock
    // form, and the dashboard.
    locked: isServiceMode() && (!isPasswordSet() || !isUnlocked()),
    password_set: isPasswordSet(),
    setup_code_required: isServiceMode() && !isPasswordSet(),
    onboarding_complete: isOnboardingComplete(),
    data_storage: await getDataStorageHealth(),
  }
  if (!authed) return apiJson("health", base)
  return apiJson("health", {
    ...base,
    has_openrouter_key: hasOpenRouterKey(),
    uptime_s: Math.floor((Date.now() - startedAt) / 1000),
    scheduler: getSchedulerHealth(),
    db_writable: isDbWritable(),
    stalled_runs: countStalledRuns(),
    agentmail_configured: canSendAgentMail(),
  })
}

export async function handleCompleteOnboarding(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  const body = (await req.json().catch(() => ({}))) as { openrouter_key?: unknown }
  if (typeof body.openrouter_key === "string" && body.openrouter_key.trim()) {
    setCredential("openrouter:api_key", body.openrouter_key.trim(), "openrouter")
  }
  markOnboardingComplete()
  return apiJson("completeOnboarding", { ok: true })
}

export async function handleSetupPassword(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  if (isPasswordSet()) return json({ error: "Password already set." }, 409)
  const body = (await req.json().catch(() => ({}))) as { password?: unknown; setupCode?: unknown }
  // Service mode: this endpoint is internet-reachable and public, so gate it on
  // the one-time setup code printed to the server logs — only the operator can
  // read those, so a network attacker can't claim the instance first.
  if (isServiceMode() && !verifySetupCode(typeof body.setupCode === "string" ? body.setupCode : null)) {
    return json({ error: "Invalid or missing setup code. Check the server logs for the current code.", setupCodeRequired: true }, 403)
  }
  if (typeof body.password !== "string") return json({ error: "password is required" }, 400)
  try {
    setPassword(body.password)
  } catch (e: any) {
    return json({ error: e?.message ?? "Failed to set password" }, 400)
  }
  clearSetupCode()
  const token = issueToken()
  return apiJsonWithHeaders("setupPassword", { ok: true }, { "Set-Cookie": setCookieHeader(token) })
}

export async function handleChangePassword(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  if (!isPasswordSet()) return json({ error: "No password is set yet." }, 409)
  if (!isUnlocked()) return json({ error: "Unlock first, then change your password." }, 423)
  const body = (await req.json().catch(() => ({}))) as { newPassword?: unknown }
  if (typeof body.newPassword !== "string") return json({ error: "newPassword is required" }, 400)
  try {
    changePassword(body.newPassword)
  } catch (e: any) {
    return json({ error: e?.message ?? "Failed to change password" }, 400)
  }
  const token = issueToken()
  return apiJsonWithHeaders("changePassword", { ok: true }, { "Set-Cookie": setCookieHeader(token) })
}

export async function handleUnlock(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  if (!isPasswordSet()) return json({ error: "No password set. Set one first via /api/setup-password." }, 409)

  // Only enforce rate limits when exposed to the internet. Local `jig start`
  // has no proxy, so every request looks like the same "unknown" IP; rate-
  // limiting the loopback serves nobody.
  const enforceLimit = isServiceMode()
  const ip = enforceLimit ? clientIpFromRequest(req) : ""
  if (enforceLimit) {
    const check = checkUnlockLimit(ip)
    if (!check.ok) {
      return new Response(
        JSON.stringify({ error: "Too many failed attempts. Try again later.", retry_after_s: check.retryAfterS }),
        { status: 429, headers: { "Content-Type": "application/json", "Retry-After": String(check.retryAfterS) } },
      )
    }
  }

  const body = (await req.json().catch(() => ({}))) as { password?: unknown }
  if (typeof body.password !== "string") return json({ error: "password is required" }, 400)

  const ok = unlock(body.password)
  if (!ok) {
    if (enforceLimit) recordUnlockFailure(ip)
    return json({ error: "Wrong password" }, 401)
  }
  if (enforceLimit) recordUnlockSuccess(ip)
  const token = issueToken()
  return apiJsonWithHeaders("unlock", { ok: true }, { "Set-Cookie": setCookieHeader(token) })
}

export function handleOAuthCallback(url: URL): Response {
  const state = url.searchParams.get("state")
  const code = url.searchParams.get("code")
  const error = url.searchParams.get("error")
  if (error) {
    return new Response(renderOAuthErrorPage("the service", error), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  }
  if (!code) {
    return new Response(renderOAuthErrorPage("the service", "Missing code in callback"), {
      status: 400,
      headers: { "Content-Type": "text/html; charset=utf-8" },
    })
  }
  // Prefer state-based routing; fall back to single-pending-provider match for
  // OAuth servers that drop state on the return leg (seen with some MCP servers
  // that build authorize URLs without forwarding state).
  const matchedServer = state
    ? completePendingOAuth(state, code)
    : completePendingOAuthStateless(code)
  if (!matchedServer) {
    return new Response(
      renderOAuthErrorPage("the service", state
        ? "No pending authorization matched this callback. Try connecting again."
        : "Callback dropped the state parameter and more than one authorization is in flight. Try connecting one service at a time."),
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
    )
  }
  // Real server name so the success page's "Back to connections" deep-link opens
  // the right pane instead of a literal "your service" connection.
  return new Response(renderOAuthSuccessPage(matchedServer), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

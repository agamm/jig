/**
 * Bun API server — dashboard/backend boundary.
 *
 * Route parsing and side-effect orchestration live here; domain logic lives in
 * dedicated services under src/services and src/domain.
 */
process.env.JIG_LOG_SOURCE = process.env.JIG_LOG_SOURCE ?? "server"
import "./server/log-buffer.js" // side-effect import — must be first, installs console capture
import { existsSync, readFileSync, readdirSync, rmSync } from "fs"
import { join } from "path"
import { closeDb, deleteJigLocalState, openDb } from "./db.js"
import { getModelCatalog, setModelOverrides } from "./config/models.js"
import { fetchOpenRouterModels } from "./services/openrouter-catalog.js"
import { CONNECTIONS_DIR, DB_PATH, DRAFT_JIGS_DIR, JIGS_DIR, NOTIFICATION_TOOLS_PATH, SCHEMAS_DIR, TYPES_DIR } from "./config/paths.js"
import { extractConnections, getJigFilePath, resolveJigPath } from "./domain/jig-source.js"
import { invalidateJigsCache } from "./discover.js"
import {
  cronToText,
  replaceTriggerInSource,
  textToTrigger,
  textToTriggerLLM,
  triggerToSource,
} from "./domain/triggers.js"
import { createCustomRemoteServer, loadCustomServerConfigs, loadServerConfigs } from "./mcp/config.js"
import { buildJigResponse, discoverAllJigs } from "./services/jig-api.js"
import { approveAgentDraft, closeAgentSession, getAgentSessionStatus, listUnderConstructionJigs, pushAgentMessage, startAgentSession } from "./services/agent-service.js"
import { cancelActiveRun, getActiveRunSnapshot, getRunDetail, startJigRun } from "./services/run-api.js"
import { getNotificationHealth, getNotificationSettings, getNotificationTestStatus, saveNotificationSettings, saveNotificationTestStatus, notify, type NotificationSettings } from "./services/notify.js"
import { connectConfiguredServer, disconnectConfiguredServer } from "./services/connect-server.js"
import { getDataStorageHealth } from "./services/data-storage.js"
import { addExampleJig, listExampleJigs } from "./services/example-jigs.js"
import { buildNotificationManifest } from "./mcp/discover/notification-manifest.js"
import { handleWebhook } from "./scheduler/webhooks.js"
import { getSchedule, listAllSchedules, setScheduleEnabled, listAuthorizedSenders, addAuthorizedSender, removeAuthorizedSender, listToolPermissions, setToolPermission, listCredentials, type ToolPermissionPolicy } from "./db.js"
import { startScheduler } from "./scheduler/index.js"
import { syncSchedules } from "./scheduler/sync.js"
import { getJigVersionDetail, listJigVersions, restoreJigVersion } from "./services/jig-versioning.js"
import { writeJigSource } from "./services/jig-writer.js"
import { resetSessionLog } from "./debug/session-log.js"
import { ApiError, apiJson, apiJsonWithHeaders, json } from "./server/http.js"
import { broadcastJigsUpdated, createLiveUpdatesResponse, startLiveUpdateWatchers } from "./server/live-updates.js"
import { matchRoute } from "./server/router.js"
import { firstLineSummary } from "./text.js"
import { isCancellationError, USER_CANCELLED_MESSAGE } from "./run-cancel.js"
import { isServiceMode, publicUrl } from "./config/runtime.js"
import { getSystemSettings, saveSystemSettings, seedSystemSettingsDefaults } from "./config/timezone.js"
import { changePassword, isPasswordSet, isUnlocked, setPassword, unlock } from "./crypto/password.js"
import { checkAccess, requireAdminAccess } from "./auth/lock-middleware.js"
import { issueToken, setCookieHeader } from "./auth/session.js"
import {
  checkUnlockLimit,
  clientIpFromRequest,
  recordUnlockFailure,
  recordUnlockSuccess,
} from "./auth/unlock-rate-limit.js"
import { completePendingOAuth, completePendingOAuthStateless, renderOAuthErrorPage, renderOAuthSuccessPage } from "./mcp/auth.js"
import { clearLogs, getLogs } from "./server/log-buffer.js"
import { getCredential, setCredential } from "./db.js"
import packageJson from "../package.json"

const PACKAGE_VERSION: string = packageJson.version
const SERVER_STARTED_AT = Date.now()

function ensureJigExists(id: string): void {
  if (!discoverAllJigs().has(id)) throw new ApiError(404, `Jig not found: ${id}`)
}

function removeStaleDraftFiles(): void {
  rmSync(DRAFT_JIGS_DIR, { recursive: true, force: true })
}

async function handleGetVersions(jigId: string): Promise<Response> {
  ensureJigExists(jigId)
  try {
    return apiJson("getVersions", await listJigVersions(jigId))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.message === "No version history") {
      return apiJson("getVersions", [])
    }
    throw error
  }
}

async function handleGetVersionCode(jigId: string, sha: string): Promise<Response> {
  ensureJigExists(jigId)
  return apiJson("getVersionCode", await getJigVersionDetail(jigId, sha))
}

async function handleRestoreVersion(jigId: string, sha: string): Promise<Response> {
  ensureJigExists(jigId)
  const { hasActiveRunForJig } = await import("./services/run-store.js")
  if (hasActiveRunForJig(jigId)) {
    throw new ApiError(409, "Cannot restore a jig version while it is running")
  }
  return apiJson("restoreVersion", await restoreJigVersion(jigId, sha))
}

async function handleGetSteps(id: string): Promise<Response> {
  ensureJigExists(id)
  const filePath = getJigFilePath(id)
  if (!filePath) throw new ApiError(404, "Jig file not found")
  const code = readFileSync(filePath, "utf-8")
  const { deriveSteps } = await import("./derive-steps.js")
  const steps = await deriveSteps(id, code)
  return apiJson("getSteps", { steps })
}

async function handleUpdateTrigger(id: string, body: any): Promise<Response> {
  const triggerText = body?.trigger as string
  if (!triggerText) throw new ApiError(400, "Missing trigger text")

  ensureJigExists(id)
  const filePath = getJigFilePath(id)
  if (!filePath) throw new ApiError(404, "Jig file not found")

  const trigger = textToTrigger(triggerText) ?? await textToTriggerLLM(triggerText)
  if (!trigger) throw new ApiError(400, `Could not parse trigger: "${triggerText}"`)
  if (trigger.type !== "cron" && trigger.type !== "manual" && trigger.type !== "webhook") {
    throw new ApiError(400, `Unsupported trigger type: "${trigger.type}". Expected cron, manual, or webhook.`)
  }

  let code: string
  try {
    code = readFileSync(filePath, "utf-8")
  } catch {
    throw new ApiError(404, "Jig file not readable")
  }

  const updated = replaceTriggerInSource(code, triggerToSource(trigger))
  if (!updated) throw new ApiError(400, "Could not find trigger in source file")

  await writeJigSource(filePath, updated, {
    jigId: id,
    commit: true,
    commitMessage: `jig: ${id} — update trigger`,
    commitPrompt: `Update trigger to: ${triggerText}`,
  })

  const newTriggerText = trigger.type === "cron" && trigger.cron ? cronToText(trigger.cron)
    : trigger.type === "manual" ? "Manual"
    : trigger.type === "webhook" ? "Webhook"
    : triggerText

  const result = { ok: true, trigger: newTriggerText } as {
    ok: true
    trigger: string
    warning?: string
  }
  if ("approximate" in trigger && trigger.approximate) {
    result.warning = ("note" in trigger && typeof trigger.note === "string" && trigger.note)
      || "This is an approximation — cron cannot express the exact schedule"
  }
  await syncSchedules()
  return apiJson("updateTrigger", result)
}

async function handleGetConnections(): Promise<Response> {
  const configs = await loadServerConfigs()
  const customConfigs = await loadCustomServerConfigs()
  const connections = await Promise.all(
    Object.entries(configs).map(async ([name, config]) => {
      const schemaPath = `${SCHEMAS_DIR}/${name}.json`
      const connected = existsSync(schemaPath)
      let toolCount = 0
      if (connected) {
        try {
          const schema = JSON.parse(readFileSync(schemaPath, "utf-8"))
          toolCount = Array.isArray(schema) ? schema.length : 0
        } catch {}
      }
      return {
        name,
        connected,
        toolCount,
        description: config.description,
        custom: Boolean(customConfigs[name]),
        proxyVia: config.proxy?.via,
        proxyDashboardUrl: config.proxy?.dashboardUrl,
      }
    })
  )
  return apiJson("connections", connections)
}

async function handleGetConnection(name: string): Promise<Response> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new ApiError(400, "Invalid connection name")
  const configs = await loadServerConfigs()
  const customConfigs = await loadCustomServerConfigs()
  const config = (configs as Record<string, any>)[name]
  if (!config) throw new ApiError(404, `Connection not found: ${name}`)

  const schemaPath = join(SCHEMAS_DIR, `${name}.json`)
  const connected = existsSync(schemaPath)
  let tools: { name: string; description: string; readOnly: boolean; destructive: boolean }[] = []

  if (connected) {
    try {
      const schemas = JSON.parse(readFileSync(schemaPath, "utf-8"))
      tools = schemas.map((tool: any) => {
        const destructive = tool.annotations?.destructiveHint === true
        // Destructive tools are never read-only — normalize to avoid ambiguity
        const readOnly = !destructive && tool.annotations?.readOnlyHint === true
        return {
          name: tool.name,
          description: firstLineSummary(tool.description),
          readOnly,
          destructive,
        }
      })
    } catch {}
  }

  const usedBy: string[] = []
  for (const id of discoverAllJigs().keys()) {
    const filePath = getJigFilePath(id)
    if (!filePath) continue
    try {
      const code = readFileSync(filePath, "utf-8")
      if (extractConnections(code).includes(name)) usedBy.push(id)
    } catch {}
  }

  return apiJson("getConnection", {
    name,
    connected,
    toolCount: tools.length,
    description: config.description ?? "",
    custom: Boolean(customConfigs[name]),
    proxyVia: config.proxy?.via,
    proxyDashboardUrl: config.proxy?.dashboardUrl,
    tools,
    usedBy,
  })
}

async function handleCreateCustomConnection(body: any): Promise<Response> {
  const name = typeof body?.name === "string" ? body.name : ""
  const url = typeof body?.url === "string" ? body.url : ""
  const description = typeof body?.description === "string" ? body.description : ""

  if (!name.trim()) throw new ApiError(400, "Missing connection name")
  if (!url.trim()) throw new ApiError(400, "Missing MCP URL")

  try {
    const result = await createCustomRemoteServer({ name, url, description })
    return apiJson("createCustomConnection", {
      ok: true,
      connection: {
        name: result.name,
        connected: false,
        toolCount: 0,
        description: result.config.description,
        custom: true,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create custom connection"
    if (message.startsWith("Connection already exists")) throw new ApiError(409, message)
    throw new ApiError(400, message)
  }
}

async function handleDeleteJig(id: string): Promise<Response> {
  ensureJigExists(id)

  const { hasActiveRunForJig } = await import("./services/run-store.js")
  if (hasActiveRunForJig(id)) {
    throw new ApiError(409, "Cannot delete a jig while it is running")
  }

  const filePath = getJigFilePath(id)
  if (!filePath) throw new ApiError(404, "Jig file not found")
  rmSync(filePath, { force: true })
  deleteJigLocalState(id)
  const { clearTrackedRunsForJig } = await import("./services/run-store.js")
  clearTrackedRunsForJig(id)

  invalidateJigsCache()
  return apiJson("deleteJig", { ok: true, jigId: id })
}

async function handleResetLocalState(): Promise<Response> {
  const disconnectedConnections = [...new Set([
    ...listCredentials().map((row) => row.server),
    ...(existsSync(SCHEMAS_DIR)
      ? readdirSync(SCHEMAS_DIR).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, ""))
      : []),
  ])].sort()

  const { closeAllConnections } = await import("./mcp/client.js")
  await closeAllConnections()
  closeDb()

  const deletedJigs: string[] = []
  if (existsSync(JIGS_DIR)) {
    for (const name of readdirSync(JIGS_DIR)) {
      const target = join(JIGS_DIR, name)
      rmSync(target, { recursive: true, force: true })
      deletedJigs.push(name)
    }
  }

  for (const ext of ["", "-shm", "-wal"]) {
    rmSync(`${DB_PATH}${ext}`, { force: true })
  }

  // Remove generated local MCP artifacts too so onboarding is truly fresh.
  rmSync(NOTIFICATION_TOOLS_PATH, { force: true })
  rmSync(SCHEMAS_DIR, { recursive: true, force: true })
  rmSync(TYPES_DIR, { recursive: true, force: true })
  rmSync(CONNECTIONS_DIR, { recursive: true, force: true })

  invalidateJigsCache()
  openDb()

  return apiJson("resetLocalState", { ok: true, deletedJigs, disconnectedConnections })
}

function handleOAuthCallback(url: URL): Response {
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
  // Prefer state-based routing; fall back to single-pending-provider match
  // for OAuth servers that drop state on the return leg (seen with some
  // MCP servers that build authorize URLs without forwarding state).
  const matched = state
    ? completePendingOAuth(state, code)
    : completePendingOAuthStateless(code)
  if (!matched) {
    return new Response(
      renderOAuthErrorPage("the service", state
        ? "No pending authorization matched this callback. Try connecting again."
        : "Callback dropped the state parameter and more than one authorization is in flight. Try connecting one service at a time."),
      { status: 404, headers: { "Content-Type": "text/html; charset=utf-8" } },
    )
  }
  // Server name isn't directly known here; completePendingOAuth returns
  // boolean. Render a generic success page — the dashboard link is the
  // same for any server.
  return new Response(renderOAuthSuccessPage("your service"), {
    status: 200,
    headers: { "Content-Type": "text/html; charset=utf-8" },
  })
}

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

async function handleCompleteOnboarding(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  const body = (await req.json().catch(() => ({}))) as { openrouter_key?: unknown }
  if (typeof body.openrouter_key === "string" && body.openrouter_key.trim()) {
    setCredential("openrouter:api_key", body.openrouter_key.trim(), "openrouter")
  }
  markOnboardingComplete()
  return apiJson("completeOnboarding", { ok: true })
}

async function handleSetupPassword(req: Request): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  if (isPasswordSet()) return json({ error: "Password already set." }, 409)
  const body = (await req.json().catch(() => ({}))) as { password?: unknown }
  if (typeof body.password !== "string") return json({ error: "password is required" }, 400)
  try {
    setPassword(body.password)
  } catch (e: any) {
    return json({ error: e?.message ?? "Failed to set password" }, 400)
  }
  const token = issueToken()
  return apiJsonWithHeaders("setupPassword", { ok: true }, { "Set-Cookie": setCookieHeader(token) })
}

async function handleChangePassword(req: Request): Promise<Response> {
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

async function handleUnlock(req: Request): Promise<Response> {
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

export function createApiServer(port: number) {
  openDb()
  seedSystemSettingsDefaults()
  removeStaleDraftFiles()
  startLiveUpdateWatchers()
  // Clear step cache on startup — ensures stale derivations from old SDK versions don't persist
  const { clearAllStepCache } = require("./db.js")
  clearAllStepCache()

  return Bun.serve({
    port,
    // /api/events sends SSE heartbeats every 15s, so Bun's 10s default would
    // close the stream first and produce noisy "failed to pipe response" logs.
    idleTimeout: 30,
    async fetch(req) {
      const url = new URL(req.url)
      const route = matchRoute(url.pathname)
      if (!route) return json({ error: "Unknown API route" }, 404)

      const blocked = checkAccess(req, route.handler)
      if (blocked) return blocked

      try {
        switch (route.handler) {
          case "health": {
            // `health` is the only /api/* route that's reachable without auth
            // in service mode — the dashboard calls it to decide which
            // onboarding screen to show. Only emit the fields UnlockGate
            // actually needs there; put admin-only fields (uptime, has-key)
            // behind auth so an unauthenticated attacker can't fingerprint
            // the instance's OpenRouter state or last restart time.
            const authed = !isServiceMode() || checkAccess(req, "serverLogs") === null
            const base = {
              version: PACKAGE_VERSION,
              mode: isServiceMode() ? "service" as const : "local" as const,
              public_url: publicUrl() ?? null,
              // In service mode, "locked" means credentials are unreachable —
              // whether because no password has been set yet OR because the
              // key isn't in memory. UnlockGate uses this to decide between
              // the set-password form, the unlock form, and the dashboard.
              locked: isServiceMode() && (!isPasswordSet() || !isUnlocked()),
              password_set: isPasswordSet(),
              onboarding_complete: isOnboardingComplete(),
              data_storage: await getDataStorageHealth(),
            }
            if (!authed) return apiJson("health", base)
            return apiJson("health", {
              ...base,
              has_openrouter_key: hasOpenRouterKey(),
              uptime_s: Math.floor((Date.now() - SERVER_STARTED_AT) / 1000),
            })
          }
          case "completeOnboarding":
            return handleCompleteOnboarding(req)
          case "setupPassword":
            return handleSetupPassword(req)
          case "unlock":
            return handleUnlock(req)
          case "changePassword":
            return handleChangePassword(req)
          case "oauthCallback":
            return handleOAuthCallback(url)
          case "liveUpdates":
            return createLiveUpdatesResponse()
          case "models": {
            if (req.method === "PUT") {
              const body = (await req.json().catch(() => ({}))) as {
                main?: unknown; editor?: unknown; fast?: unknown
              }
              const patch: { main?: string; editor?: string; fast?: string } = {}
              for (const k of ["main", "editor", "fast"] as const) {
                const v = body[k]
                if (v === undefined) continue
                if (typeof v !== "string") throw new ApiError(400, `${k} must be a string`)
                patch[k] = v
              }
              return apiJson("models", setModelOverrides(patch))
            }
            return apiJson("models", getModelCatalog())
          }
          case "modelsCatalog":
            return apiJson("modelsCatalog", await fetchOpenRouterModels())
          case "listJigs": {
            const jigs = await Promise.all(
              [...discoverAllJigs().keys()].map((id) => buildJigResponse(id, 10, true))
            )
            const existingIds = new Set(jigs.map((jig) => jig.id))
            const drafts = (await listUnderConstructionJigs()).filter((jig) => !existingIds.has(jig.id))
            return apiJson("listJigs", [...drafts, ...jigs])
          }
          case "listExamples":
            return apiJson("listExamples", listExampleJigs())
          case "addExample": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            try {
              const jigId = await addExampleJig(route.params.id)
              return apiJson("addExample", { ok: true, jigId })
            } catch (error: any) {
              if (error?.message?.startsWith("Jig already exists:")) {
                throw new ApiError(409, error.message)
              }
              if (error?.message?.startsWith("Example jig not found:") || error?.message === "Invalid example jig id") {
                throw new ApiError(404, error.message)
              }
              throw error
            }
          }
          case "getJig": {
            if (req.method === "DELETE") return handleDeleteJig(route.params.id)
            ensureJigExists(route.params.id)
            return apiJson("getJig", await buildJigResponse(route.params.id, 20, true))
          }
          case "runJig": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return apiJson("runJig", await startJigRun(route.params.id, body))
          }
          case "getRun":
            return apiJson("getRun", getRunDetail(parseInt(route.params.id)))
          case "activeRun":
            return apiJson("activeRun", getActiveRunSnapshot(url.searchParams.get("jigId") ?? undefined))
          case "cancelRun": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return apiJson("cancelRun", await cancelActiveRun(body?.jigId))
          }
          case "connections":
            return handleGetConnections()
          case "createCustomConnection": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return handleCreateCustomConnection(body)
          }
          case "getConnection":
            return handleGetConnection(route.params.name)
          case "connectConnection": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({})) as { credentials?: Record<string, string> }
            return apiJson("connectConnection", await connectConfiguredServer(route.params.name, { credentials: body?.credentials, signal: req.signal }))
          }
          case "disconnectConnection": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return apiJson("disconnectConnection", await disconnectConfiguredServer(route.params.name))
          }
          case "getSteps": {
            return handleGetSteps(route.params.id)
          }
          case "updateTrigger": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return handleUpdateTrigger(route.params.id, body)
          }
          case "startAgent": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return apiJson("startAgent", await startAgentSession(body))
          }
          case "agentStatus": {
            const since = parseInt(url.searchParams.get("since") ?? "0")
            return apiJson("agentStatus", getAgentSessionStatus(route.params.sessionId, since))
          }
          case "agentMessage": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return apiJson("agentMessage", await pushAgentMessage(route.params.sessionId, body))
          }
          case "agentApprove": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return apiJson("agentApprove", await approveAgentDraft(route.params.sessionId))
          }
          case "agentClose": {
            if (req.method !== "DELETE") return json({ error: "Method not allowed" }, 405)
            return apiJson("agentClose", await closeAgentSession(route.params.sessionId))
          }
          case "getVersions":
            return handleGetVersions(route.params.id)
          case "getVersionCode":
            return handleGetVersionCode(route.params.id, route.params.sha)
          case "restoreVersion": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return handleRestoreVersion(route.params.id, route.params.sha)
          }
          case "listSchedules":
            return apiJson("listSchedules", listAllSchedules().map(s => ({
              jigId: s.jig_id,
              triggerType: s.trigger_type,
              cronExpr: s.cron_expr,
              timezone: s.timezone,
              missedStrategy: s.missed_strategy,
              nextRunAt: s.next_run_at ? new Date(s.next_run_at * 1000).toISOString() : null,
              lastRunAt: s.last_run_at ? new Date(s.last_run_at * 1000).toISOString() : null,
              enabled: s.enabled === 1,
              error: s.error,
            })))
          case "updateSchedule": {
            if (req.method !== "PATCH") return json({ error: "Method not allowed" }, 405)
            ensureJigExists(route.params.jigId)
            if (!getSchedule(route.params.jigId)) throw new ApiError(404, `No schedule found for jig: ${route.params.jigId}`)
            const body = await req.json().catch(() => ({}))
            if (typeof body?.enabled !== "boolean") throw new ApiError(400, "Missing 'enabled' boolean")
            setScheduleEnabled(route.params.jigId, body.enabled)
            broadcastJigsUpdated("schedule")
            return apiJson("updateSchedule", { ok: true })
          }
          case "authorizedSenders": {
            if (req.method === "GET") return apiJson("authorizedSenders", listAuthorizedSenders())
            if (req.method === "POST") {
              const body = await req.json().catch(() => ({}))
              if (!body?.channel || !body?.sender_id) throw new ApiError(400, "Missing 'channel' and 'sender_id'")
              addAuthorizedSender(body.channel, body.sender_id)
              return apiJson("addAuthorizedSender", { ok: true })
            }
            return json({ error: "Method not allowed" }, 405)
          }
          case "deleteAuthorizedSender": {
            if (req.method !== "DELETE") return json({ error: "Method not allowed" }, 405)
            const removed = removeAuthorizedSender(route.params.channel, route.params.senderId)
            if (!removed) throw new ApiError(404, "Sender not found")
            return apiJson("deleteAuthorizedSender", { ok: true })
          }
          case "notificationSettings": {
            if (req.method === "GET") {
              const settings = getNotificationSettings()
              const availableTools = buildNotificationManifest()
              return apiJson("notificationSettings", {
                settings,
                availableTools,
                health: getNotificationHealth(settings, availableTools),
                testStatus: getNotificationTestStatus(),
              })
            }
            if (req.method === "PUT") {
              const body = await req.json().catch(() => ({})) as Partial<NotificationSettings>
              if (!body || !Array.isArray(body.channels)) {
                throw new ApiError(400, "Body must include a 'channels' array")
              }
              const next: NotificationSettings = {
                channels: body.channels,
                triggerOn: { fail: body.triggerOn?.fail ?? true },
              }
              saveNotificationSettings(next)
              const settings = getNotificationSettings()
              const availableTools = buildNotificationManifest()
              return apiJson("notificationSettings", {
                settings,
                availableTools,
                health: getNotificationHealth(settings, availableTools),
                testStatus: getNotificationTestStatus(),
              })
            }
            return json({ error: "Method not allowed" }, 405)
          }
          case "notificationSettingsTest": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const report = await notify({
              title: "Jig test notification",
              body: "If you see this, notifications are working.",
              kind: "fail",
              ignoreTriggerGate: true,
            })
            saveNotificationTestStatus(report)
            return apiJson("notificationSettingsTest", report)
          }
          case "systemSettings": {
            if (req.method === "GET") return apiJson("systemSettings", getSystemSettings())
            if (req.method === "PUT") {
              const body = await req.json().catch(() => ({}))
              const settings = saveSystemSettings({ timezone: body?.timezone })
              await syncSchedules()
              broadcastJigsUpdated("system-settings")
              return apiJson("systemSettings", settings)
            }
            return json({ error: "Method not allowed" }, 405)
          }
          case "toolPermissions": {
            if (req.method === "GET") {
              return apiJson("toolPermissions", listToolPermissions())
            }
            if (req.method === "PUT") {
              const body = await req.json().catch(() => ({})) as {
                connection?: string
                tool?: string
                policy?: ToolPermissionPolicy
              }
              if (!body?.connection || !body?.tool || !body?.policy) {
                throw new ApiError(400, "Body must include 'connection', 'tool', and 'policy'")
              }
              if (!["always", "ask", "never"].includes(body.policy)) {
                throw new ApiError(400, "Invalid policy. Expected always, ask, or never.")
              }
              setToolPermission(body.connection, body.tool, body.policy)
              return apiJson("saveToolPermission", { ok: true })
            }
            return json({ error: "Method not allowed" }, 405)
          }
          case "resetLocalState": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return handleResetLocalState()
          }
          case "serverLogs": {
            // Defense in depth: logs are admin-only even if the global route
            // allow-list changes later. Railway CLI should use platform logs;
            // this endpoint exists only for the authenticated dashboard.
            const denied = requireAdminAccess(req)
            if (denied) return denied
            if (req.method === "DELETE") {
              clearLogs()
              return apiJson("clearServerLogs", { ok: true })
            }
            if (req.method !== "GET") return json({ error: "Method not allowed" }, 405)
            const since = parseInt(url.searchParams.get("since") ?? "0")
            return apiJson("serverLogs", { entries: getLogs(Number.isFinite(since) ? since : 0) })
          }
          case "webhook": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const token = url.searchParams.get("token")
            const webhookBody = await req.json().catch(() => ({}))
            const result = handleWebhook(route.params.jigId, token, webhookBody)
            return json(result.body, result.status)
          }
          default:
            return json({ error: "Unknown handler" }, 404)
        }
      } catch (error: any) {
        if (req.signal.aborted || isCancellationError(error)) {
          return json({ error: USER_CANCELLED_MESSAGE }, 499)
        }
        if (error instanceof ApiError) {
          return json({
            error: error.message,
            ...(error.details ? { details: error.details } : {}),
          }, error.status)
        }
        console.error("API error:", error)
        return json({ error: error?.message ?? "Internal server error" }, 500)
      }
    },
  })
}

process.on("unhandledRejection", (error) => {
  console.error("[server] unhandled rejection:", error)
})

if (import.meta.main) {
  const port = parseInt(process.env.PORT ?? "3141")
  await resetSessionLog()
  const server = createApiServer(port)
  const scheduler = await startScheduler().catch((e) => {
    console.error("[scheduler] failed to start:", e)
    return null
  })
  const cleanup = async () => {
    const { closeAllConnections } = await import("./mcp/client.js")
    await closeAllConnections()
    scheduler?.stop()
    server.stop(true)
    process.exit(0)
  }
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)
  console.log(`API server on http://localhost:${server.port}`)
}

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
import { CONNECTIONS_DIR, DB_PATH, JIGS_DIR, NOTIFICATION_TOOLS_PATH, SCHEMAS_DIR, TYPES_DIR } from "./config/paths.js"
import { extractConnections } from "./domain/jig-source.js"
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
import { approveAgentDraft, closeAgentSession, getAgentSessionStatus, listUnderConstructionJigs, pushAgentMessage, startAgentSession, streamAgentSession } from "./services/agent-service.js"
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
import {
  approvePending as approveJigPending,
  deleteJig as storeDeleteJig,
  discardPending as discardJigPending,
  getActiveCode as getJigActiveCode,
  getActiveVersion as getJigActiveVersion,
  getJigRow,
  getPending as getJigPending,
  getVersion as getJigVersion,
  listHistoryVersions as listJigHistoryVersions,
  listJigs as storeListJigs,
  restoreVersion as restoreToPendingVersion,
  setModelOverride as storeSetModelOverride,
  writePending as storeWritePending,
  type JigVersion as JigVersionStoreRow,
} from "./services/jig-store.js"
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

// ---------------------------------------------------------------------------
// v12: code-as-versions handlers
// ---------------------------------------------------------------------------

function jigVersionToRecord(v: JigVersionStoreRow) {
  return {
    id: v.id,
    jigId: v.jigId,
    author: v.author,
    message: v.message,
    prompt: v.prompt,
    parentVersionId: v.parentVersionId,
    createdAt: v.createdAt,
  }
}

function ensureJigStoreRow(jigId: string): void {
  if (!getJigRow(jigId)) throw new ApiError(404, `Jig not found: ${jigId}`)
}

function handleGetPending(jigId: string): Response {
  // Pending may exist on a brand-new jig that doesn't yet have a `jigs/{id}.ts`
  // file — so we DON'T call ensureJigExists here. The store row is enough.
  if (!getJigRow(jigId)) return apiJson("getPending", null)
  return apiJson("getPending", getJigPending(jigId))
}

async function handleApprovePending(jigId: string): Promise<Response> {
  ensureJigStoreRow(jigId)
  const { hasActiveRunForJig } = await import("./services/run-store.js")
  if (hasActiveRunForJig(jigId)) {
    throw new ApiError(409, "Cannot approve a pending change while the jig is running")
  }
  if (!getJigPending(jigId)) throw new ApiError(404, "No pending changes")
  const { activeVersionId } = approveJigPending(jigId)
  return apiJson("approvePending", { ok: true as const, jigId, activeVersionId })
}

function handleDiscardPending(jigId: string): Response {
  ensureJigStoreRow(jigId)
  if (!getJigPending(jigId)) {
    return apiJson("discardPending", { ok: true as const, jigId })
  }
  discardJigPending(jigId)
  return apiJson("discardPending", { ok: true as const, jigId })
}

async function handleRestoreToPending(jigId: string, body: { versionId?: unknown }): Promise<Response> {
  ensureJigStoreRow(jigId)
  const { hasActiveRunForJig } = await import("./services/run-store.js")
  if (hasActiveRunForJig(jigId)) {
    throw new ApiError(409, "Cannot restore while the jig is running")
  }
  const versionId = typeof body.versionId === "number" ? body.versionId : NaN
  if (!Number.isFinite(versionId)) throw new ApiError(400, "Missing or invalid versionId")
  const source = getJigVersion(versionId)
  if (!source || source.jigId !== jigId) throw new ApiError(404, "Version not found")
  if (getJigPending(jigId)) {
    throw new ApiError(409, "A pending change already exists — approve or discard it before restoring an older version")
  }
  const { pendingVersionId } = restoreToPendingVersion({ jigId, versionId })
  return apiJson("restoreToPending", { ok: true as const, jigId, pendingVersionId })
}

function handleListVersionsV2(jigId: string): Response {
  const row = getJigRow(jigId)
  if (!row) return apiJson("listVersionsV2", { active: null, pending: null, history: [] })
  const active = getJigActiveVersion(jigId)
  const pending = row.pending_version_id != null ? getJigVersion(row.pending_version_id) : null
  const history = listJigHistoryVersions(jigId).filter((v) => v.id !== active?.id)
  return apiJson("listVersionsV2", {
    active: active ? jigVersionToRecord(active) : null,
    pending: pending ? jigVersionToRecord(pending) : null,
    history: history.map(jigVersionToRecord),
  })
}

async function handleGetSteps(id: string): Promise<Response> {
  ensureJigExists(id)
  const code = getJigActiveCode(id)
  if (!code) throw new ApiError(404, "Jig has no active version")
  const { deriveSteps } = await import("./derive-steps.js")
  const steps = await deriveSteps(id, code)
  return apiJson("getSteps", { steps })
}

async function handleUpdateTrigger(id: string, body: any): Promise<Response> {
  const triggerText = body?.trigger as string
  if (!triggerText) throw new ApiError(400, "Missing trigger text")

  ensureJigExists(id)
  const code = getJigActiveCode(id)
  if (!code) throw new ApiError(404, "Jig has no active version")

  const trigger = textToTrigger(triggerText) ?? await textToTriggerLLM(triggerText)
  if (!trigger) throw new ApiError(400, `Could not parse trigger: "${triggerText}"`)
  if (trigger.type !== "cron" && trigger.type !== "manual" && trigger.type !== "webhook") {
    throw new ApiError(400, `Unsupported trigger type: "${trigger.type}". Expected cron, manual, or webhook.`)
  }

  const updated = replaceTriggerInSource(code, triggerToSource(trigger))
  if (!updated) throw new ApiError(400, "Could not find trigger in source file")

  // Trigger edits are metadata — they don't need an approval gate. Write a
  // new version and promote it to active in one go via the store.
  storeWritePending({
    jigId: id,
    code: updated,
    author: "cli",
    message: `update trigger`,
    prompt: `Update trigger to: ${triggerText}`,
  })
  approveJigPending(id)

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
    const code = getJigActiveCode(id)
    if (!code) continue
    if (extractConnections(code).includes(name)) usedBy.push(id)
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
  if (!getJigRow(id)) throw new ApiError(404, `Jig not found: ${id}`)

  const { hasActiveRunForJig } = await import("./services/run-store.js")
  if (hasActiveRunForJig(id)) {
    throw new ApiError(409, "Cannot delete a jig while it is running")
  }

  storeDeleteJig(id)
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

  const deletedJigs = storeListJigs().map((j) => j.id)
  for (const id of deletedJigs) storeDeleteJig(id)
  // Also wipe any legacy filesystem files so a fresh boot doesn't re-ingest them.
  if (existsSync(JIGS_DIR)) {
    for (const name of readdirSync(JIGS_DIR)) {
      rmSync(join(JIGS_DIR, name), { recursive: true, force: true })
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
  startLiveUpdateWatchers()
  // Clear step cache on startup — ensures stale derivations from old SDK versions don't persist
  const { clearAllStepCache } = require("./db.js")
  clearAllStepCache()

  // Regenerate connection bindings on boot. The .ts wrappers under
  // CONNECTIONS_DIR are templated from code (e.g. composio's proxyCallCode);
  // when that template changes between releases, deployed instances need to
  // re-emit their bindings or jigs keep running against the old wrapper.
  // Best-effort — schemas may not exist yet on a fresh box.
  void import("./mcp/typegen.js").then(async ({ generateConnectionArtifacts }) => {
    try { await generateConnectionArtifacts() } catch (err: any) {
      console.warn(`[typegen] boot-time regeneration failed: ${err?.message ?? err}`)
    }
  })

  // v12 migration: sync every legacy jigs/*.ts + git history into the
  // jig_versions table. Runs on every boot, per-jig idempotent — picks up
  // any new files that appeared since the previous boot.
  void import("./services/jig-import.js").then(async ({ syncLegacyJigs }) => {
    try {
      const summary = await syncLegacyJigs()
      if (summary && summary.jigsImported > 0) {
        console.log(
          `[migration] imported ${summary.jigsImported} legacy jigs (${summary.versionsImported} versions)` +
          (summary.jigsSkipped ? `, skipped ${summary.jigsSkipped}` : ""),
        )
      }
    } catch (err: any) {
      console.warn(`[migration] legacy jig import failed: ${err?.message ?? err}`)
    }
  })

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
          case "updateJigModel": {
            // PATCH /api/jigs/<id>/model — dashboard sets or clears the per-jig
            // model override. Pass {model: null} to clear and fall back to the
            // jig's code-declared model (or global default).
            if (req.method !== "PATCH") return json({ error: "Method not allowed" }, 405)
            const body = (await req.json().catch(() => ({}))) as { model?: unknown }
            ensureJigExists(route.params.id)
            let next: string | null = null
            if (body.model === null || body.model === undefined) {
              next = null
            } else if (typeof body.model === "string") {
              next = body.model.trim() || null
            } else {
              throw new ApiError(400, "model must be a string or null")
            }
            storeSetModelOverride(route.params.id, next)
            invalidateJigsCache()
            broadcastJigsUpdated()
            return apiJson("updateJigModel", { ok: true as const, jigId: route.params.id, model: next })
          }
          case "writeJigCode": {
            // Direct code write for an existing jig — creates (or replaces) the
            // pending version. With approve:true, immediately promotes pending
            // to active. Useful for scripted/CLI-driven edits when going through
            // the interactive authoring agent would be excessive.
            if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405)
            const body = (await req.json().catch(() => ({}))) as {
              code?: unknown; message?: unknown; approve?: unknown
            }
            if (typeof body.code !== "string" || body.code.trim().length === 0) {
              throw new ApiError(400, "code is required")
            }
            ensureJigExists(route.params.id)
            const { hasActiveRunForJig } = await import("./services/run-store.js")
            if (hasActiveRunForJig(route.params.id)) {
              throw new ApiError(409, "Cannot edit while the jig is running")
            }
            const message = typeof body.message === "string" ? body.message : null
            const { versionId } = storeWritePending({
              jigId: route.params.id,
              code: body.code,
              author: "cli",
              message,
              prompt: null,
            })
            let activeVersionId: number | null = null
            if (body.approve === true) {
              activeVersionId = approveJigPending(route.params.id).activeVersionId
              invalidateJigsCache()
            }
            broadcastJigsUpdated()
            return apiJson("writeJigCode", { ok: true as const, pendingVersionId: versionId, activeVersionId })
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
          case "agentStream": {
            const lastEventId = parseInt(req.headers.get("last-event-id") ?? url.searchParams.get("since") ?? "0")
            return streamAgentSession(route.params.sessionId, lastEventId, req.signal)
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
          case "pending": {
            if (req.method === "GET") return handleGetPending(route.params.id)
            if (req.method === "DELETE") return handleDiscardPending(route.params.id)
            return json({ error: "Method not allowed" }, 405)
          }
          case "approvePending": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return handleApprovePending(route.params.id)
          }
          case "restoreToPending": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return handleRestoreToPending(route.params.id, body)
          }
          case "listVersionsV2": {
            return handleListVersionsV2(route.params.id)
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

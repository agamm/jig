/**
 * Bun API server — dashboard/backend boundary.
 *
 * Route parsing and side-effect orchestration live here; domain logic lives in
 * dedicated services under src/services and src/domain.
 */
process.env.JIG_LOG_SOURCE = process.env.JIG_LOG_SOURCE ?? "server"
import "./server/log-buffer.js" // side-effect import — must be first, installs console capture
import { openDb } from "./db.js"
import { getModelCatalog, setModelOverrides } from "./config/models.js"
import { fetchOpenRouterModels } from "./services/openrouter-catalog.js"
import { fetchOpenRouterCredits } from "./services/openrouter-credits.js"
import {
  applyUpgrade as applyModelUpgradeImpl,
  computeUpgradeSuggestions,
  dismissUpgrade as dismissModelUpgradeImpl,
} from "./services/model-upgrade.js"
import { buildJigResponse, discoverAllJigs } from "./services/jig-api.js"
import { approveAgentDraft, closeAgentSession, getAgentSessionStatus, listUnderConstructionJigs, pushAgentMessage, startAgentSession, streamAgentSession } from "./services/agent-service.js"
import { cancelActiveRun, getActiveRunSnapshot, getRunDetail, startJigRun } from "./services/run-api.js"
import {
  canSendAgentMail,
  getAgentMailSettings,
  getAgentMailStatus,
  saveAgentMailSettings,
  sendAgentMailEmail,
  setupAgentMail,
} from "./services/agentmail.js"
import { handleInboundEmail } from "./services/email-inbound.js"
import { disconnectConfiguredServer } from "./services/connect-server.js"
import { addExampleJig, listExampleJigs } from "./services/example-jigs.js"
import { handleWebhook } from "./scheduler/webhooks.js"
import { getSchedule, listAllSchedules, setScheduleEnabled, listAuthorizedSenders, addAuthorizedSender, removeAuthorizedSender, listToolPermissions, setToolPermission, type ToolPermissionPolicy } from "./db.js"
import { startScheduler } from "./scheduler/index.js"
import { syncSchedules } from "./scheduler/sync.js"
import {
  getJigRow,
  setModelOverride as storeSetModelOverride,
  setStepModelOverride as storeSetStepModelOverride,
  setJigTimeouts as storeSetJigTimeouts,
} from "./services/jig-store.js"
import { resetSessionLog } from "./debug/session-log.js"
import { ApiError, apiJson, json } from "./server/http.js"
import {
  handleChangePassword,
  handleCompleteOnboarding,
  handleHealth,
  handleOAuthCallback,
  handleOpenRouterCallback,
  handleSetupPassword,
  handleUnlock,
} from "./server/handlers/auth.js"
import { broadcastJigsUpdated, createLiveUpdatesResponse } from "./server/live-updates.js"
import { matchRoute } from "./server/router.js"
import {
  ensureJigExists,
  handleDeleteJig,
  handleJigMemory,
  handleJigReminders,
  handleGetSteps,
  handleUpdateTrigger,
} from "./server/handlers/jigs.js"
import {
  handleResetLocalState,
  parseModelId,
  parseSlot,
} from "./server/handlers/admin.js"
import {
  handleCreateCustomConnection,
  handleConnectConnection,
  handleGetConnection,
  handleGetConnections,
  handleGetConnectionTypes,
} from "./server/handlers/connections.js"
import {
  handleApprovePending,
  handleDiscardPending,
  handleGetPending,
  handleListVersionsV2,
  handleRestoreToPending,
  handleWriteJigCode,
} from "./server/handlers/versions.js"
import { isCancellationError, USER_CANCELLED_MESSAGE } from "./run-cancel.js"
import { isServiceMode, publicUrl, publicUrlFromRequest } from "./config/runtime.js"
import { getSystemSettings, saveSystemSettings, seedSystemSettingsDefaults } from "./config/timezone.js"
import { isPasswordSet } from "./crypto/password.js"
import { checkAccess, requireAdminAccess } from "./auth/lock-middleware.js"
import { announceSetupCode } from "./auth/setup-code.js"
import { clearLogs, getLogs } from "./server/log-buffer.js"
import packageJson from "../package.json"

const PACKAGE_VERSION: string = packageJson.version
const SERVER_STARTED_AT = Date.now()

/**
 * Re-emit the connection bindings under CONNECTIONS_DIR. The .ts wrappers are
 * templated from code (e.g. composio's proxyCallCode); when that template
 * changes between releases, deployed instances need to re-emit or jigs keep
 * running against the old wrapper.
 *
 * Await this BEFORE serving and before the scheduler recovers missed runs.
 * Every boot rewrites the files in place, and Bun caches an imported module by
 * path — so a run that imports a wrapper mid-rewrite either dies on a truncated
 * file or pins the stale binding for the rest of the process's life, which is
 * the exact failure this call exists to prevent.
 *
 * Best-effort — schemas may not exist yet on a fresh box.
 */
export async function regenerateConnectionArtifacts(): Promise<void> {
  try {
    const { generateConnectionArtifacts } = await import("./mcp/typegen.js")
    await generateConnectionArtifacts()
  } catch (err: any) {
    console.warn(`[typegen] boot-time regeneration failed: ${err?.message ?? err}`)
  }
}

export function createApiServer(port: number) {
  openDb()
  seedSystemSettingsDefaults()
  // Unclaimed internet-exposed instance: print the one-time setup code the
  // owner needs to claim it (closes the first-boot takeover race).
  if (isServiceMode() && !isPasswordSet()) announceSetupCode()
  // Clear step cache on startup — ensures stale derivations from old SDK versions don't persist
  const { clearAllStepCache } = require("./db.js")
  clearAllStepCache()

  const apiServer = Bun.serve({
    port,
    // Bind loopback only. The Bun API is an internal service — the co-located
    // Next.js proxy (same host in every mode) is its sole client, reaching it
    // over 127.0.0.1. Never expose it on 0.0.0.0: in local mode `checkAccess`
    // is a no-op, so a 0.0.0.0 bind would serve the whole unauthenticated API
    // to the LAN. See start.ts for the user-facing (Next) bind.
    hostname: "127.0.0.1",
    // /api/events sends SSE heartbeats every 15s, so Bun's 10s default would
    // close the stream first and produce noisy "failed to pipe response" logs.
    idleTimeout: 30,
    async fetch(req) {
      try {
        const url = new URL(req.url)
        const route = matchRoute(url.pathname)
        if (!route) return json({ error: "Unknown API route" }, 404)

        const blocked = checkAccess(req, route.handler)
        if (blocked) return blocked

        switch (route.handler) {
          case "health":
            return handleHealth(req, PACKAGE_VERSION, SERVER_STARTED_AT)
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
          case "startOpenRouterOAuth": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const { startOpenRouterOAuth } = await import("./services/openrouter-oauth.js")
            // The origin the caller reached us on is the most reliable answer to
            // "where can OpenRouter send them back", better than an env var the
            // platform may not have set.
            return apiJson("startOpenRouterOAuth", startOpenRouterOAuth(publicUrlFromRequest(req)))
          }
          case "openRouterOAuthCallback":
            return handleOpenRouterCallback(url)
          case "createPairingCode": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const { mintPairingCode } = await import("./auth/pairing.js")
            return apiJson("createPairingCode", mintPairingCode())
          }
          case "pairingStatus": {
            const { getPairingStatus } = await import("./auth/pairing.js")
            return apiJson("pairingStatus", getPairingStatus())
          }
          case "claimPairingCode": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = (await req.json().catch(() => ({}))) as { code?: unknown }
            const code = typeof body.code === "string" ? body.code : ""
            const { claimPairingCode } = await import("./auth/pairing.js")
            if (!code || !claimPairingCode(code)) {
              return json({ error: "That pairing code is not valid, already used, or expired." }, 401)
            }
            const { issueToken } = await import("./auth/session.js")
            return apiJson("claimPairingCode", { token: issueToken() })
          }
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
          case "openrouterCredits":
            return apiJson("openrouterCredits", await fetchOpenRouterCredits())
          case "modelProbe": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const { probeModel } = await import("./services/model-probe.js")
            const { getMainModel } = await import("./config/models.js")
            return apiJson("modelProbe", await probeModel(getMainModel()))
          }
          case "classifyFailure": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = (await req.json().catch(() => ({}))) as { error?: unknown }
            const text = typeof body.error === "string" ? body.error : ""
            const { classifyAuthFailure } = await import("./services/classify-failure.js")
            return apiJson("classifyFailure", { needsReauth: text ? await classifyAuthFailure(text) : false })
          }
          case "modelUpgrades":
            return apiJson("modelUpgrades", await computeUpgradeSuggestions())
          case "applyModelUpgrade": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
            return apiJson(
              "applyModelUpgrade",
              applyModelUpgradeImpl(parseSlot(body.slot), parseModelId(body.modelId), body.updateJigs === true),
            )
          }
          case "dismissModelUpgrade": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
            dismissModelUpgradeImpl(parseSlot(body.slot), parseModelId(body.modelId))
            return apiJson("dismissModelUpgrade", { ok: true as const })
          }
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
            return apiJson("getJig", await buildJigResponse(route.params.id, 20, true, true))
          }
          case "runJig": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return apiJson("runJig", await startJigRun(route.params.id, body))
          }
          case "updateJigStepModel": {
            // PATCH /api/jigs/<id>/step-model — set or clear a single step's
            // model override. Step seq is 1-indexed (matches what the runner
            // reports to onStepStart and what /api/jigs/<id>/steps returns).
            if (req.method !== "PATCH") return json({ error: "Method not allowed" }, 405)
            const body = (await req.json().catch(() => ({}))) as { seq?: unknown; model?: unknown }
            ensureJigExists(route.params.id)
            const seq = typeof body.seq === "number" && Number.isInteger(body.seq) && body.seq > 0 ? body.seq : NaN
            if (!Number.isFinite(seq)) throw new ApiError(400, "seq must be a positive integer")
            let next: string | null = null
            if (body.model === null || body.model === undefined) {
              next = null
            } else if (typeof body.model === "string") {
              next = body.model.trim() || null
            } else {
              throw new ApiError(400, "model must be a string or null")
            }
            storeSetStepModelOverride(route.params.id, seq, next)
            broadcastJigsUpdated()
            return apiJson("updateJigStepModel", { ok: true as const, jigId: route.params.id, seq, model: next })
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
            broadcastJigsUpdated()
            return apiJson("updateJigModel", { ok: true as const, jigId: route.params.id, model: next })
          }
          case "updateJigTimeouts": {
            // PATCH /api/jigs/<id>/timeouts — set or clear per-jig run/tool
            // timeout overrides (ms). Omit a field to leave it; pass null or a
            // non-positive value to clear it back to the global default.
            if (req.method !== "PATCH") return json({ error: "Method not allowed" }, 405)
            ensureJigExists(route.params.id)
            const body = (await req.json().catch(() => ({}))) as { runTimeoutMs?: unknown; toolTimeoutMs?: unknown }
            const parse = (v: unknown): number | null | undefined => {
              if (v === undefined) return undefined
              if (v === null) return null
              if (typeof v !== "number" || !Number.isFinite(v)) throw new ApiError(400, "timeout must be a positive number, null, or omitted")
              return v > 0 ? v : null
            }
            const runTimeoutMs = parse(body.runTimeoutMs)
            const toolTimeoutMs = parse(body.toolTimeoutMs)
            storeSetJigTimeouts(route.params.id, {
              ...(runTimeoutMs !== undefined ? { runTimeoutMs } : {}),
              ...(toolTimeoutMs !== undefined ? { toolTimeoutMs } : {}),
            })
            broadcastJigsUpdated()
            const updated = getJigRow(route.params.id)
            return apiJson("updateJigTimeouts", {
              ok: true as const,
              jigId: route.params.id,
              runTimeoutMs: updated?.run_timeout_ms ?? null,
              toolTimeoutMs: updated?.tool_timeout_ms ?? null,
            })
          }
          case "evalTool": {
            // Invoke one tool against the live connection and report what it
            // actually returns. Delegates to the same introspectToolOutput the
            // authoring agent uses, so the read-only gate, the composio proxy
            // wrap/unwrap, spill detection and redaction are shared rather than
            // reimplemented here. It answers the question you otherwise can
            // only answer by shipping a jig and reading the logs.
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = (await req.json().catch(() => ({}))) as {
              tool?: unknown; args?: unknown; allowWrite?: unknown
            }
            if (typeof body.tool !== "string" || body.tool.trim().length === 0) {
              throw new ApiError(400, "tool is required")
            }
            const toolArgs = body.args && typeof body.args === "object" && !Array.isArray(body.args)
              ? body.args as Record<string, unknown>
              : {}
            const { introspectToolOutput } = await import("./services/introspect.js")
            const result = await introspectToolOutput({
              server: route.params.name,
              tool: body.tool.trim(),
              args: toolArgs,
              allowWrite: body.allowWrite === true,
            })
            return apiJson("evalTool", result)
          }
          case "verifyConnection": {
            // Proves the connection works right now. The wizard advances on
            // this, never on "a schema file exists" — see connection-verify.ts.
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const { verifyConnection } = await import("./services/connection-verify.js")
            return apiJson("verifyConnection", await verifyConnection(route.params.name))
          }
          case "writeJigCode": {
            // Direct code write (CLI / coding agents). Creates the jig if
            // needed, lands pending, typechecks, approves only when clean.
            if (req.method !== "PUT") return json({ error: "Method not allowed" }, 405)
            const body = (await req.json().catch(() => ({}))) as { code?: unknown; message?: unknown; approve?: unknown }
            const res = await handleWriteJigCode(route.params.id, body)
            broadcastJigsUpdated()
            return res
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
          case "connectionTypes":
            return handleGetConnectionTypes()
          case "createCustomConnection": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return handleCreateCustomConnection(body)
          }
          case "getConnection":
            return handleGetConnection(route.params.name)
          case "connectConnection": {
            return handleConnectConnection(req, route.params.name)
          }
          case "disconnectConnection": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return apiJson("disconnectConnection", await disconnectConfiguredServer(route.params.name))
          }
          case "getSteps": {
            return handleGetSteps(route.params.id)
          }
          case "jigMemory": {
            return handleJigMemory(route.params.id, req.method, url.searchParams.get("key"))
          }
          case "jigReminders": {
            return handleJigReminders(route.params.id, req.method, url.searchParams.get("key"))
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
          case "agentMailSettings": {
            if (req.method === "PUT") {
              const body = (await req.json().catch(() => ({}))) as Record<string, unknown>
              saveAgentMailSettings({
                apiKey: typeof body.apiKey === "string" ? body.apiKey : undefined,
                owner: typeof body.owner === "string" ? body.owner : undefined,
                notifyOnFailure: typeof body.notifyOnFailure === "boolean" ? body.notifyOnFailure : undefined,
              })
            } else if (req.method !== "GET") {
              return json({ error: "Method not allowed" }, 405)
            }
            return apiJson("agentMailSettings", getAgentMailStatus())
          }
          case "agentMailSetup": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            // Public URL (for the inbound reply-to-edit webhook) is auto-detected
            // from the platform (Railway/Render/Fly) or the dashboard's own
            // origin. If none resolves (e.g. localhost), we still provision a
            // send-only inbox — alerts work; reply-to-edit just isn't wired up.
            const base = publicUrl() ?? publicUrlFromRequest(req)
            try {
              const { address, webhookReady } = await setupAgentMail(base ? `${base}/api/email/inbound` : null)
              return apiJson("agentMailSetup", { ok: true as const, address, webhookReady })
            } catch (e: any) {
              return apiJson("agentMailSetup", { ok: false as const, error: e?.message ?? String(e) })
            }
          }
          case "agentMailTest": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const owner = getAgentMailSettings().owner
            if (!canSendAgentMail() || !owner) {
              return apiJson("agentMailTest", { ok: false as const, error: "AgentMail can't send yet — add a key + email and connect an inbox." })
            }
            try {
              await sendAgentMailEmail({
                to: owner,
                subject: "Jig alerts are working",
                text: "If you can read this, Jig can email you when a jig fails — even when its MCP connections are down. If reply-to-edit is set up, replying routes your message to the jig's authoring agent.",
              })
              return apiJson("agentMailTest", { ok: true as const })
            } catch (e: any) {
              return apiJson("agentMailTest", { ok: false as const, error: e?.message ?? String(e) })
            }
          }
          case "emailInbound": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            // Svix verification needs the raw, unparsed body bytes.
            const rawBody = await req.text()
            const result = await handleInboundEmail(rawBody, req.headers)
            return json(result.body, result.status)
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
          case "backupDownload": {
            // Admin-only: the archive carries every credential this instance
            // holds. Encrypted, but still not something an unauthenticated
            // caller should be able to walk off with.
            const denied = requireAdminAccess(req)
            if (denied) return denied
            if (req.method !== "GET") return json({ error: "Method not allowed" }, 405)

            const { collectSnapshot } = await import("./backup/index.js")
            const { buildArchive } = await import("./backup/archive.js")
            const includeCredentials = url.searchParams.get("credentials") !== "0"
            const archive = buildArchive(collectSnapshot(), {
              jigVersion: PACKAGE_VERSION,
              createdAt: new Date().toISOString(),
              includeCredentials,
            })
            const stamp = new Date().toISOString().slice(0, 10)
            return new Response(archive as unknown as BodyInit, {
              headers: {
                "Content-Type": "application/zip",
                "Content-Disposition": `attachment; filename="jig-backup-${stamp}.zip"`,
                "Content-Length": String(archive.length),
              },
            })
          }
          case "backupRestore": {
            const denied = requireAdminAccess(req)
            if (denied) return denied
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)

            const { parseArchive } = await import("./backup/archive.js")
            const { applyRestore, planRestore } = await import("./backup/index.js")
            const body = new Uint8Array(await req.arrayBuffer())
            if (body.length === 0) return json({ error: "No file was uploaded." }, 400)

            let parsed
            try {
              parsed = parseArchive(body)
            } catch (e: any) {
              return json({ error: e?.message ?? "That file is not a jig backup." }, 400)
            }

            const dryRun = url.searchParams.get("dryRun") === "1"
            const force = url.searchParams.get("force") === "1"
            if (dryRun) {
              return apiJson("backupRestore", {
                manifest: parsed.manifest,
                plan: planRestore(parsed.snapshot),
                applied: false,
              })
            }
            const result = applyRestore(parsed.snapshot, { force })
            await syncSchedules()
            broadcastJigsUpdated("backup-restore")
            return apiJson("backupRestore", {
              manifest: parsed.manifest,
              plan: result,
              applied: true,
            })
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
  // Publish the bound port so local OAuth can route its callback through this
  // always-running server's /api/oauth/callback instead of an ephemeral loopback.
  process.env.JIG_API_PORT = String(apiServer.port)
  return apiServer
}

process.on("unhandledRejection", (error) => {
  console.error("[server] unhandled rejection:", error)
})

// log-buffer.ts registers an uncaughtException listener to record the error,
// which suppresses the runtime's default fatal exit — without this handler
// the process would keep running in an undefined state after a crash.
// Exit non-zero instead so a supervisor (systemd / Railway / launchd)
// restarts us; recoverMissedRuns() marks orphaned runs failed on next boot.
process.on("uncaughtException", (error) => {
  console.error("[server] uncaught exception — exiting so the supervisor restarts us:", error)
  process.exit(1)
})

if (import.meta.main) {
  const port = parseInt(process.env.PORT ?? "3141")
  await resetSessionLog()
  // Ahead of regeneration, which reads credentials for proxy configs — so a
  // schema/migration failure crashes boot instead of surfacing as a misleading
  // "[typegen] regeneration failed" warning.
  openDb()
  await regenerateConnectionArtifacts()
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

/**
 * Bun API server — dashboard/backend boundary.
 *
 * Route parsing and side-effect orchestration live here; domain logic lives in
 * dedicated services under src/services and src/domain.
 */
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { closeDb, deleteJigLocalState, openDb } from "./db.js"
import { getModelCatalog } from "./config/models.js"
import { CONNECTIONS_DIR, DRAFT_JIGS_DIR, JIGS_DIR, PROJECT_ROOT, SCHEMAS_DIR, TYPES_DIR } from "./config/paths.js"
import { extractConnections, getJigFilePath, resolveJigPath } from "./domain/jig-source.js"
import { invalidateJigsCache } from "./discover.js"
import {
  cronToText,
  replaceTriggerInSource,
  textToTrigger,
  textToTriggerLLM,
  triggerToSource,
} from "./domain/triggers.js"
import { loadServerConfigs } from "./mcp/config.js"
import { buildJigResponse, discoverAllJigs } from "./services/jig-api.js"
import { approveAgentDraft, closeAgentSession, getAgentSessionStatus, pushAgentMessage, startAgentSession } from "./services/agent-service.js"
import { cancelActiveRun, getActiveRunSnapshot, getRunDetail, startJigRun } from "./services/run-api.js"
import { getNotificationSettings, saveNotificationSettings, notify, type NotificationSettings } from "./services/notify.js"
import { connectConfiguredServer } from "./services/connect-server.js"
import { addExampleJig, listExampleJigs } from "./services/example-jigs.js"
import { readNotificationManifest } from "./mcp/discover/notification-manifest.js"
import { handleWebhook } from "./scheduler/webhooks.js"
import { getSchedule, listAllSchedules, setScheduleEnabled, listAuthorizedSenders, addAuthorizedSender, removeAuthorizedSender, listToolPermissions, setToolPermission, listCredentials, type ToolPermissionPolicy } from "./db.js"
import { startScheduler } from "./scheduler/index.js"
import { syncSchedules } from "./scheduler/sync.js"
import { getJigVersionDetail, listJigVersions, restoreJigVersion } from "./services/jig-versioning.js"
import { resetSessionLog } from "./debug/session-log.js"
import { ApiError, json } from "./server/http.js"
import { matchRoute } from "./server/router.js"
import { firstLineSummary } from "./text.js"

function ensureJigExists(id: string): void {
  if (!discoverAllJigs().has(id)) throw new ApiError(404, `Jig not found: ${id}`)
}

function removeStaleDraftFiles(): void {
  rmSync(DRAFT_JIGS_DIR, { recursive: true, force: true })
}

async function handleGetVersions(jigId: string): Promise<Response> {
  ensureJigExists(jigId)
  try {
    return json(await listJigVersions(jigId))
  } catch (error) {
    if (error instanceof ApiError && error.status === 404 && error.message === "No version history") {
      return json([])
    }
    throw error
  }
}

async function handleGetVersionCode(jigId: string, sha: string): Promise<Response> {
  ensureJigExists(jigId)
  return json(await getJigVersionDetail(jigId, sha))
}

async function handleRestoreVersion(jigId: string, sha: string): Promise<Response> {
  ensureJigExists(jigId)
  const { hasActiveRunForJig } = await import("./services/run-store.js")
  if (hasActiveRunForJig(jigId)) {
    throw new ApiError(409, "Cannot restore a jig version while it is running")
  }
  return json(await restoreJigVersion(jigId, sha))
}

async function handleGetSteps(id: string): Promise<Response> {
  ensureJigExists(id)
  const filePath = getJigFilePath(id)
  if (!filePath) throw new ApiError(404, "Jig file not found")
  const code = readFileSync(filePath, "utf-8")
  const { deriveSteps } = await import("./derive-steps.js")
  const steps = await deriveSteps(id, code)
  return json({ steps })
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

  try {
    writeFileSync(filePath, updated)
  } catch {
    throw new ApiError(500, "Failed to write trigger to source file")
  }

  const newTriggerText = trigger.type === "cron" && trigger.cron ? cronToText(trigger.cron)
    : trigger.type === "manual" ? "Manual"
    : trigger.type === "webhook" ? "Webhook"
    : triggerText

  const result: Record<string, any> = { ok: true, trigger: newTriggerText }
  if ("approximate" in trigger && trigger.approximate) {
    result.warning = ("note" in trigger && trigger.note) || "This is an approximation — cron cannot express the exact schedule"
  }
  await syncSchedules()
  return json(result)
}

async function handleGetConnections(): Promise<Response> {
  const configs = await loadServerConfigs()
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
        proxyVia: config.proxy?.via,
        proxyDashboardUrl: config.proxy?.dashboardUrl,
      }
    })
  )
  return json(connections)
}

async function handleGetConnection(name: string): Promise<Response> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new ApiError(400, "Invalid connection name")
  const configs = await loadServerConfigs()
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

  return json({
    name,
    connected,
    toolCount: tools.length,
    description: config.description ?? "",
    proxyVia: config.proxy?.via,
    proxyDashboardUrl: config.proxy?.dashboardUrl,
    tools,
    usedBy,
  })
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
  return json({ ok: true, jigId: id })
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

  for (const file of ["jig.db", "jig.db-shm", "jig.db-wal"]) {
    rmSync(join(PROJECT_ROOT, file), { force: true })
  }

  // Remove generated local MCP artifacts too so onboarding is truly fresh.
  rmSync(join(PROJECT_ROOT, ".jig", "notification-tools.json"), { force: true })
  rmSync(SCHEMAS_DIR, { recursive: true, force: true })
  rmSync(TYPES_DIR, { recursive: true, force: true })
  rmSync(CONNECTIONS_DIR, { recursive: true, force: true })

  invalidateJigsCache()
  openDb()

  return json({ ok: true, deletedJigs, disconnectedConnections })
}

export function createApiServer(port: number) {
  openDb()
  removeStaleDraftFiles()
  // Clear step cache on startup — ensures stale derivations from old SDK versions don't persist
  const { clearAllStepCache } = require("./db.js")
  clearAllStepCache()

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const route = matchRoute(url.pathname)
      if (!route) return json({ error: "Unknown API route" }, 404)

      try {
        switch (route.handler) {
          case "getModels":
            return json(getModelCatalog())
          case "listJigs": {
            const jigs = await Promise.all(
              [...discoverAllJigs().keys()].map((id) => buildJigResponse(id, 10, true))
            )
            return json(jigs)
          }
          case "listExamples":
            return json(listExampleJigs())
          case "addExample": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            try {
              const jigId = await addExampleJig(route.params.id)
              return json({ ok: true, jigId })
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
            return json(await buildJigResponse(route.params.id, 20, true))
          }
          case "runJig": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return json(await startJigRun(route.params.id, body))
          }
          case "getRun":
            return json(getRunDetail(parseInt(route.params.id)))
          case "activeRun":
            return json(getActiveRunSnapshot(url.searchParams.get("jigId") ?? undefined))
          case "cancelRun": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return json(await cancelActiveRun(body?.jigId))
          }
          case "connections":
            return handleGetConnections()
          case "getConnection":
            return handleGetConnection(route.params.name)
          case "connectConnection": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({})) as { credentials?: Record<string, string> }
            return json(await connectConfiguredServer(route.params.name, { credentials: body?.credentials }))
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
            return json(await startAgentSession(body))
          }
          case "agentStatus": {
            const since = parseInt(url.searchParams.get("since") ?? "0")
            return json(getAgentSessionStatus(route.params.sessionId, since))
          }
          case "agentMessage": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return json(await pushAgentMessage(route.params.sessionId, body))
          }
          case "agentApprove": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return json(await approveAgentDraft(route.params.sessionId))
          }
          case "agentClose": {
            if (req.method !== "DELETE") return json({ error: "Method not allowed" }, 405)
            return json(await closeAgentSession(route.params.sessionId))
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
            return json(listAllSchedules().map(s => ({
              jigId: s.jig_id,
              triggerType: s.trigger_type,
              cronExpr: s.cron_expr,
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
            return json({ ok: true })
          }
          case "authorizedSenders": {
            if (req.method === "GET") return json(listAuthorizedSenders())
            if (req.method === "POST") {
              const body = await req.json().catch(() => ({}))
              if (!body?.channel || !body?.sender_id) throw new ApiError(400, "Missing 'channel' and 'sender_id'")
              addAuthorizedSender(body.channel, body.sender_id)
              return json({ ok: true })
            }
            return json({ error: "Method not allowed" }, 405)
          }
          case "deleteAuthorizedSender": {
            if (req.method !== "DELETE") return json({ error: "Method not allowed" }, 405)
            const removed = removeAuthorizedSender(route.params.channel, route.params.senderId)
            if (!removed) throw new ApiError(404, "Sender not found")
            return json({ ok: true })
          }
          case "notificationSettings": {
            if (req.method === "GET") {
              return json({
                settings: getNotificationSettings(),
                availableTools: readNotificationManifest(),
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
              return json({ settings: getNotificationSettings(), availableTools: readNotificationManifest() })
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
            return json(report)
          }
          case "toolPermissions": {
            if (req.method === "GET") {
              return json(listToolPermissions())
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
              return json({ ok: true })
            }
            return json({ error: "Method not allowed" }, 405)
          }
          case "resetLocalState": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return handleResetLocalState()
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

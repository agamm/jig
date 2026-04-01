/**
 * Bun API server — dashboard/backend boundary.
 *
 * Route parsing and side-effect orchestration live here; domain logic lives in
 * dedicated services under src/services and src/domain.
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { openDb } from "./db.js"
import { getModelCatalog } from "./config/models.js"
import { JIGS_DIR, PROJECT_ROOT, SCHEMAS_DIR } from "./config/paths.js"
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
import { getAgentSessionStatus, pushAgentMessage, startAgentSession } from "./services/agent-service.js"
import { cancelActiveRun, getActiveRunSnapshot, getRunDetail, startJigRun } from "./services/run-api.js"
import { getJigVersionDetail, listJigVersions, restoreJigVersion } from "./services/jig-versioning.js"
import { ApiError, json } from "./server/http.js"
import { matchRoute } from "./server/router.js"

function ensureJigExists(id: string): void {
  if (!discoverAllJigs().has(id)) throw new ApiError(404, `Jig not found: ${id}`)
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
  const activeRun = getActiveRunSnapshot()
  if (activeRun.active && activeRun.jigId === jigId) {
    throw new ApiError(409, "Cannot restore a jig version while it is running")
  }
  return json(await restoreJigVersion(jigId, sha))
}

async function handleGetSteps(id: string): Promise<Response> {
  ensureJigExists(id)
  const filePath = getJigFilePath(id)
  if (!filePath) throw new ApiError(404, "Jig file not found")

  const safePath = JSON.stringify(filePath)
  const safeId = JSON.stringify(id)

  const script = `
    import { readFileSync } from "fs";
    const { deriveSteps } = await import("./src/derive-steps.js");
    const mod = await import(${safePath} + "?_t=" + Date.now());
    if (!mod.default?.handler) { console.log("[]"); process.exit(0); }
    const code = readFileSync(${safePath}, "utf-8");
    const steps = await deriveSteps(mod.default, ${safeId}, code);
    console.log(JSON.stringify(steps));
  `

  const proc = Bun.spawn(["bun", "-e", script], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 30_000,
  })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited

  if (exitCode !== 0) return json({ steps: [] })

  try {
    return json({ steps: JSON.parse(stdout) })
  } catch {
    return json({ steps: [] })
  }
}

async function handleUpdateTrigger(id: string, body: any): Promise<Response> {
  const triggerText = body?.trigger as string
  if (!triggerText) throw new ApiError(400, "Missing trigger text")

  ensureJigExists(id)
  const filePath = getJigFilePath(id)
  if (!filePath) throw new ApiError(404, "Jig file not found")

  const trigger = textToTrigger(triggerText) ?? await textToTriggerLLM(triggerText)
  if (!trigger) throw new ApiError(400, `Could not parse trigger: "${triggerText}"`)

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
    : trigger.type === "interval" && trigger.minutes ? `Every ${trigger.minutes}m`
    : trigger.type === "event" && trigger.source ? `On ${trigger.source}`
    : trigger.type === "manual" ? "Manual"
    : trigger.type === "webhook" ? "Webhook"
    : triggerText

  const result: Record<string, any> = { ok: true, trigger: newTriggerText }
  if ("approximate" in trigger && trigger.approximate) {
    result.warning = ("note" in trigger && trigger.note) || "This is an approximation — cron cannot express the exact schedule"
  }
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
      return { name, connected, toolCount, description: config.description }
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
  let tools: { name: string; description: string; readOnly: boolean }[] = []

  if (connected) {
    try {
      const schemas = JSON.parse(readFileSync(schemaPath, "utf-8"))
      tools = schemas.map((tool: any) => ({
        name: tool.name,
        description: tool.description?.split("\n")[0] ?? "",
        readOnly: tool.annotations?.readOnlyHint === true,
      }))
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
    tools,
    usedBy,
  })
}

async function handleDeleteJig(id: string): Promise<Response> {
  ensureJigExists(id)

  const activeRun = getActiveRunSnapshot()
  if (activeRun.active && activeRun.jigId === id) {
    throw new ApiError(409, "Cannot delete a jig while it is running")
  }

  const filePath = getJigFilePath(id)
  if (!filePath) throw new ApiError(404, "Jig file not found")
  rmSync(filePath, { force: true })

  invalidateJigsCache()
  return json({ ok: true, jigId: id })
}

export function createApiServer(port: number) {
  openDb()

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
            return json(getActiveRunSnapshot())
          case "cancelRun": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return json(await cancelActiveRun())
          }
          case "connections":
            return handleGetConnections()
          case "getConnection":
            return handleGetConnection(route.params.name)
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
          case "getVersions":
            return handleGetVersions(route.params.id)
          case "getVersionCode":
            return handleGetVersionCode(route.params.id, route.params.sha)
          case "restoreVersion": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return handleRestoreVersion(route.params.id, route.params.sha)
          }
          default:
            return json({ error: "Unknown handler" }, 404)
        }
      } catch (error: any) {
        if (error instanceof ApiError) {
          return json({ error: error.message }, error.status)
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
  const server = createApiServer(port)
  console.log(`API server on http://localhost:${server.port}`)
}

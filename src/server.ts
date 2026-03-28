/**
 * Bun API server — opaque backend for the dashboard.
 *
 * Handles /api/* routes. Next.js rewrites /api/* here via next.config.ts.
 */
import { join } from "path"
import { existsSync, readFileSync } from "fs"
import { discoverJigs } from "./discover.js"
import { openDb, insertRun, completeRun, insertStep, completeStep, getJigRuns, getRun, getLastRun, getJigSteps, getJigMeta, cleanupOrphanedMeta } from "./db.js"
import { loadServerConfigs } from "./mcp/config.js"
import { formatDuration } from "./utils.js"

const PROJECT_ROOT = join(import.meta.dir, "..")
const JIGS_DIR = join(PROJECT_ROOT, "jigs")
const SCHEMAS_DIR = join(PROJECT_ROOT, ".jig/schemas")

const editLocks = new Map<string, { editId: string; status: string; message?: string; createdAt: number }>()
/** Track tool calls per run for real-time progress. */
const runProgress = new Map<number, { completedTools: string[]; activeTools: string[] }>()
/** Only one run at a time (spinner + dryRun are global singletons). */
let activeRunId: number | null = null
let activeRunAbort: { abort(): void } | null = null
let activeRunJigId: string | null = null
let activeRunDryRun = false

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prettifyId(id: string): string {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Extract params from jig source code: params: { company: "Client name" } */
function extractParams(code: string): Record<string, string> {
  const m = code.match(/params\s*:\s*\{([^}]+)\}/)
  if (!m) return {}
  const params: Record<string, string> = {}
  const entries = m[1].matchAll(/(\w+)\s*:\s*["']([^"']*)["']/g)
  for (const e of entries) params[e[1]] = e[2]
  return params
}

function extractConnections(code: string): string[] {
  const matches = code.matchAll(/from\s+["'].*?\/connections\/(\w+)\.(?:js|ts)["']/g)
  return [...new Set([...matches].map((m) => m[1]))]
}

/** Extract trigger from jig source code without importing the module. */
function extractTrigger(code: string): string {
  // Match trigger: { type: "cron", cron: "..." }
  const m = code.match(/trigger\s*:\s*\{[^}]*type\s*:\s*["'](\w+)["'][^}]*\}/)
  if (!m) return ""
  const type = m[1]
  if (type === "cron") {
    const cronMatch = m[0].match(/cron\s*:\s*["']([^"']+)["']/)
    return cronMatch ? cronToText(cronMatch[1]) : "Scheduled"
  }
  if (type === "interval") {
    const minMatch = m[0].match(/minutes\s*:\s*(\d+)/)
    return minMatch ? `Every ${minMatch[1]}m` : "Interval"
  }
  if (type === "event") {
    const srcMatch = m[0].match(/source\s*:\s*["']([^"']+)["']/)
    return srcMatch ? `On ${srcMatch[1]}` : "Event"
  }
  if (type === "manual") return "Manual"
  if (type === "webhook") return "Webhook"
  return ""
}

/** Convert a 5-field cron expression to human-readable text. */
function cronToText(cron: string): string {
  const [min, hour, dom, , dow] = cron.trim().split(/\s+/)
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]
  const time = `${hour}:${min.padStart(2, "0")}`

  if (dow !== "*" && dom === "*") {
    const dayNames = dow.split(",").map((d) => days[parseInt(d)] ?? d).join(", ")
    return `${dayNames} ${time}`
  }
  if (dom !== "*") return `${dom} of month ${time}`
  if (hour !== "*" && min !== "*") return `Daily ${time}`
  if (min.startsWith("*/")) return `Every ${min.slice(2)}m`
  return cron
}

function fileHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(content)
  return hasher.digest("hex")
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function notFound(message: string): Response {
  return json({ error: message }, 404)
}

// ---------------------------------------------------------------------------
// Shared jig response builder
// ---------------------------------------------------------------------------

function getJigFilePath(id: string, entity?: string): string | null {
  if (entity) {
    const p = join(JIGS_DIR, id, `${entity}.ts`)
    return existsSync(p) ? p : null
  }
  const single = join(JIGS_DIR, `${id}.ts`)
  if (existsSync(single)) return single
  const dir = join(JIGS_DIR, id)
  if (existsSync(dir)) {
    const jigs = discoverJigs(JIGS_DIR)
    const entities = jigs.get(id)
    if (entities && entities.length > 0) {
      return join(dir, `${entities[0]}.ts`)
    }
  }
  return null
}

function deriveStatus(jigId: string): "healthy" | "attention" | "failed" {
  try {
    const lastRun = getLastRun(jigId)
    if (!lastRun) return "attention"
    return lastRun.status === "success" ? "healthy" : lastRun.status === "fail" ? "failed" : "attention"
  } catch { return "attention" }
}

function buildEntityList(jigId: string, entities: string[]) {
  return entities.map((name) => {
    const last = getLastRun(jigId, name)
    return {
      name,
      lastRun: last?.finished_at ?? last?.started_at ?? "",
      status: (last?.status === "fail" ? "fail" : "success") as "success" | "fail",
    }
  })
}

function formatRuns(runs: ReturnType<typeof getJigRuns>) {
  // Exclude in-progress runs — those are shown in the live progress panel
  return runs.filter((r) => r.status !== "running").map((r) => ({
    date: r.started_at,
    duration: r.duration_ms ? formatDuration(r.duration_ms) : "—",
    status: (r.status === "fail" ? "fail" : "success") as "success" | "fail",
    cost: "",
    steps: r.steps.map((s) => ({
      label: s.label,
      time: s.duration_ms ? formatDuration(s.duration_ms) : "—",
      cost: undefined,
      tag: undefined,
      healed: s.status === "healed",
      output: s.output ?? undefined,
    })),
  }))
}

function buildJigResponse(id: string, entities: string[], runLimit: number) {
  const grouped = entities.length > 0
  const filePath = getJigFilePath(id, grouped ? entities[0] : undefined)
  const code = filePath ? readFileSync(filePath, "utf-8") : ""

  // Steps from SQLite (derived by creator pipeline) — graceful on DB errors
  const entity = grouped ? entities[0] : null
  let steps: any[] = []
  try {
    steps = getJigSteps(id, entity).map(s => ({
      num: s.seq,
      name: s.name,
      desc: s.description,
      cost: s.cost_hint ?? undefined,
      connections: s.connections ? JSON.parse(s.connections) : [],
      tools: s.tools ? JSON.parse(s.tools) : [],
      agentGroup: s.agent_group ?? undefined,
    }))
  } catch {}

  // Stale detection — graceful on DB errors
  let stale = true
  let runs: ReturnType<typeof getJigRuns> = []
  try {
    const meta = getJigMeta(id, entity)
    const currentHash = code ? fileHash(code) : null
    stale = !meta || (currentHash !== null && meta.code_hash !== currentHash)
    runs = getJigRuns(id, undefined, runLimit)
  } catch {}

  // Sparkline from last 7 runs' durations (normalized).
  // Math.max(...[], 1) === 1 — safe on empty arrays due to the trailing 1.
  const recentDurations = runs.slice(0, 7).map((r) => r.duration_ms ?? 0).reverse()
  const maxDur = Math.max(...recentDurations, 1)
  const sparkline = recentDurations.map((d) => Math.round((d / maxDur) * 100))

  const trigger = extractTrigger(code)

  return {
    id,
    name: prettifyId(id),
    trigger,
    status: deriveStatus(id),
    running: activeRunJigId === id && !activeRunDryRun,
    stale,
    grouped,
    entityCount: grouped ? entities.length : undefined,
    entities: grouped ? buildEntityList(id, entities) : undefined,
    sparkline,
    steps,
    code: grouped ? "" : code,
    runs: formatRuns(runs),
    params: extractParams(code),
    settings: {
      trigger,
      connections: extractConnections(code),
      permissions: [],
    },
    costMonth: "",
    costLifetime: "",
  }
}

// ---------------------------------------------------------------------------
// API route handlers
// ---------------------------------------------------------------------------

async function handleGetJigs(): Promise<Response> {
  const discovered = discoverJigs(JIGS_DIR)
  try { cleanupOrphanedMeta(new Set(discovered.keys())) } catch {}
  const jigs = [...discovered.entries()].map(([id, entities]) =>
    buildJigResponse(id, entities, 10)
  )
  return json(jigs)
}

async function handleGetJig(id: string): Promise<Response> {
  const discovered = discoverJigs(JIGS_DIR)
  if (!discovered.has(id)) return notFound(`Jig not found: ${id}`)
  return json(buildJigResponse(id, discovered.get(id)!, 20))
}

async function handleRunJig(id: string, body: any): Promise<Response> {
  const discovered = discoverJigs(JIGS_DIR)
  if (!discovered.has(id)) return notFound(`Jig not found: ${id}`)

  const entities = discovered.get(id)!
  const entity = body?.entity as string | undefined
  const params = (body?.params ?? {}) as Record<string, string>
  const dryRun = body?.dryRun === true

  let jigPath: string
  if (entities.length === 0) {
    jigPath = join(JIGS_DIR, `${id}.ts`)
  } else {
    if (!entity) return json({ error: `Grouped jig requires entity. Available: ${entities.join(", ")}` }, 400)
    if (!entities.includes(entity)) return json({ error: `Entity not found: ${entity}` }, 400)
    jigPath = join(JIGS_DIR, id, `${entity}.ts`)
  }

  if (!existsSync(jigPath)) return notFound(`Jig file not found`)

  // Check connections are set up
  const connectionsDir = join(PROJECT_ROOT, ".jig/connections")
  if (!existsSync(join(connectionsDir, "index.ts"))) {
    return json({ error: "No connections found. Run 'jig connect <server>' first." }, 400)
  }

  // Only one run at a time — spinner and dryRun are global singletons.
  if (activeRunId !== null) return json({ error: "A run is already in progress" }, 409)

  // Only persist real runs — dry runs are ephemeral
  const runId = dryRun ? -1 : insertRun(id, entity, Object.keys(params).length > 0 ? params : undefined)
  activeRunId = runId
  activeRunAbort = new AbortController()
  activeRunJigId = id
  activeRunDryRun = dryRun

  const startTime = Date.now()
  const workerPath = join(PROJECT_ROOT, "src/run-worker.ts")
  const workerArgs = [workerPath, jigPath]
  if (dryRun) workerArgs.push("--dry-run")
  if (Object.keys(params).length > 0) workerArgs.push("--params", JSON.stringify(params))

  const proc = Bun.spawn(["bun", "run", ...workerArgs], {
    cwd: PROJECT_ROOT,
    stdout: "pipe",
    stderr: "inherit",
    env: { ...process.env },
  })
  activeRunAbort = { abort: () => proc.kill(9) }

  // Read stdout for progress updates
  ;(async () => {
    try {
      const reader = proc.stdout.getReader()
      const decoder = new TextDecoder()
      let buffer = ""

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split("\n")
        buffer = lines.pop() ?? ""

        for (const line of lines) {
          if (!line.trim()) continue
          try {
            const msg = JSON.parse(line)
            if (msg.type === "tool") {
              runProgress.set(runId, { completedTools: msg.completed ?? [], activeTools: msg.active ?? [] })
            } else if (msg.type === "done") {
              if (!dryRun) {
                const tools = msg.tools ?? []
                for (let seq = 0; seq < tools.length; seq++) {
                  const sid = insertStep(runId, seq + 1, tools[seq])
                  completeStep(sid, "", "success", 0)
                }
                if (msg.output) {
                  const sid = insertStep(runId, tools.length + 1, "Result")
                  completeStep(sid, msg.output, "success", Date.now() - startTime)
                }
                completeRun(runId, "success", Date.now() - startTime)
              }
            } else if (msg.type === "error") {
              if (!dryRun) completeRun(runId, "fail", Date.now() - startTime, msg.message)
              console.error(`Run ${runId} failed:`, msg.message)
            }
          } catch {}
        }
      }

      const exitCode = await proc.exited
      // If process exited without a done/error message (killed)
      if (exitCode !== 0 && activeRunId === runId) {
        if (!dryRun) completeRun(runId, "fail", Date.now() - startTime, "Process killed")
      }
    } finally {
      activeRunId = null
      activeRunAbort = null
      activeRunJigId = null
      activeRunDryRun = false
      runProgress.delete(runId)
    }
  })()

  return json({ runId })
}

async function handleCancelRun(): Promise<Response> {
  if (activeRunId === null) return json({ error: "No run in progress" }, 404)
  const runId = activeRunId
  // Kill the subprocess — cleanup happens in the finally block of the reader
  const label = activeRunDryRun ? "Dry run" : `Run #${runId}`
  const jigName = activeRunJigId ?? "unknown"
  process.stderr.write(`\n\x1b[33m${label} of ${jigName} cancelled by user\x1b[0m\n`)
  if (activeRunAbort) activeRunAbort.abort()
  return json({ ok: true, runId })
}

async function handleGetActiveRun(): Promise<Response> {
  if (activeRunId === null) return json({ active: false })
  const progress = runProgress.get(activeRunId)
  return json({
    active: true,
    runId: activeRunId,
    completedTools: progress?.completedTools ?? [],
    activeTools: progress?.activeTools ?? [],
  })
}

async function handleGetRun(runId: number): Promise<Response> {
  const run = getRun(runId)

  // For dry runs (runId=-1) or in-progress runs, serve from runProgress
  const progress = runProgress.get(runId)
  if (!run && progress) {
    return json({
      id: runId, status: "running", durationMs: null, error: null,
      completedTools: progress.completedTools, activeTools: progress.activeTools,
      steps: [],
    })
  }
  if (!run) return notFound(`Run not found: ${runId}`)

  return json({
    id: run.id,
    jigId: run.jig_id,
    entity: run.entity,
    startedAt: run.started_at,
    finishedAt: run.finished_at,
    status: run.status,
    durationMs: run.duration_ms,
    error: run.error,
    completedTools: progress?.completedTools ?? [],
    activeTools: progress?.activeTools ?? [],
    steps: run.steps.map((s) => ({
      label: s.label,
      time: s.duration_ms ? formatDuration(s.duration_ms) : "—",
      status: s.status,
      output: s.output,
      error: s.error,
      healed: s.status === "healed",
    })),
  })
}

async function handleRecompile(id: string, body: any): Promise<Response> {
  const discovered = discoverJigs(JIGS_DIR)
  if (!discovered.has(id)) return notFound(`Jig not found: ${id}`)

  const entity = body?.entity as string | undefined
  const filePath = getJigFilePath(id, entity)
  if (!filePath) return notFound(`Jig file not found`)

  const code = readFileSync(filePath, "utf-8")

  // Derive steps from source code (no module import — avoids MCP connection issues)
  const { deriveSteps } = await import("./creator.js")
  await deriveSteps(code, id, entity)

  const steps = getJigSteps(id, entity ?? null)
  return json({
    ok: true,
    steps: steps.map(s => ({ num: s.seq, name: s.name, desc: s.description, cost: s.cost_hint })),
  })
}

async function handleEditJig(id: string, body: any): Promise<Response> {
  const discovered = discoverJigs(JIGS_DIR)
  if (!discovered.has(id)) return notFound(`Jig not found: ${id}`)

  const instruction = body?.instruction as string
  if (!instruction) return json({ error: "instruction is required" }, 400)

  const entity = body?.entity as string | undefined
  const lockKey = entity ? `${id}/${entity}` : id

  if (editLocks.has(lockKey)) return json({ error: "Edit already in progress" }, 409)

  const editId = crypto.randomUUID()
  editLocks.set(lockKey, { editId, status: "planning", createdAt: Date.now() })

  ;(async () => {
    try {
      const { editJig } = await import("./creator.js")
      const io = {
        ask: async () => instruction,
        emit: (event: any) => {
          const lock = editLocks.get(lockKey)
          if (!lock) return
          if (event.type === "plan") lock.status = "selecting-tools"
          else if (event.type === "probe-start") lock.status = "probing"
          else if (event.type === "generate-start") lock.status = "generating"
          else if (event.type === "validate") lock.status = "validating"
          else if (event.type === "dry-run-start") lock.status = "dry-running"
          else if (event.type === "updated") lock.status = "done"
          else if (event.type === "error") { lock.status = "error"; lock.message = event.message }
        },
      }
      await editJig(id, entity, instruction, io)
      const lock = editLocks.get(lockKey)
      if (lock) lock.status = "done"
    } catch (e: any) {
      const lock = editLocks.get(lockKey)
      if (lock) { lock.status = "error"; lock.message = e?.message ?? String(e) }
    }
  })()

  return json({ editId })
}

async function handleEditStatus(id: string, editId: string): Promise<Response> {
  // Clean up stale locks (older than 10 minutes)
  const staleMs = 10 * 60 * 1000
  for (const [key, lock] of editLocks) {
    if (Date.now() - lock.createdAt > staleMs) editLocks.delete(key)
  }

  for (const [key, lock] of editLocks) {
    if ((key === id || key.startsWith(id + "/")) && lock.editId === editId) {
      const result = { status: lock.status, message: lock.message }
      if (lock.status === "done" || lock.status === "error") editLocks.delete(key)
      return json(result)
    }
  }
  return json({ status: "done" })
}

async function handleGetConnections(): Promise<Response> {
  const configs = await loadServerConfigs()
  const connections = await Promise.all(
    Object.entries(configs).map(async ([name, config]) => {
      const schemaPath = join(SCHEMAS_DIR, `${name}.json`)
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

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

function matchRoute(pathname: string): { handler: string; params: Record<string, string> } | null {
  if (pathname === "/api/jigs") return { handler: "listJigs", params: {} }
  if (pathname === "/api/connections") return { handler: "connections", params: {} }

  const jigMatch = pathname.match(/^\/api\/jigs\/([^/]+)$/)
  if (jigMatch) return { handler: "getJig", params: { id: jigMatch[1] } }

  const runMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/run$/)
  if (runMatch) return { handler: "runJig", params: { id: runMatch[1] } }

  const runDetailMatch = pathname.match(/^\/api\/runs\/(\d+)$/)
  if (runDetailMatch) return { handler: "getRun", params: { id: runDetailMatch[1] } }

  const recompileMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/recompile$/)
  if (recompileMatch) return { handler: "recompile", params: { id: recompileMatch[1] } }

  const editMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/edit$/)
  if (editMatch) return { handler: "editJig", params: { id: editMatch[1] } }

  const editStatusMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/edit-status$/)
  if (editStatusMatch) return { handler: "editStatus", params: { id: editStatusMatch[1] } }

  if (pathname === "/api/runs/active") return { handler: "activeRun", params: {} }
  if (pathname === "/api/runs/cancel") return { handler: "cancelRun", params: {} }

  return null
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

export function createApiServer(port: number) {
  openDb()

  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url)
      const route = matchRoute(url.pathname)
      if (!route) return notFound("Unknown API route")

      try {
        switch (route.handler) {
          case "listJigs":
            return handleGetJigs()
          case "getJig":
            return handleGetJig(route.params.id)
          case "runJig": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return handleRunJig(route.params.id, body)
          }
          case "getRun":
            return handleGetRun(parseInt(route.params.id))
          case "connections":
            return handleGetConnections()
          case "recompile": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return handleRecompile(route.params.id, body)
          }
          case "editJig": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return handleEditJig(route.params.id, body)
          }
          case "editStatus": {
            const editId = url.searchParams.get("editId") ?? ""
            return handleEditStatus(route.params.id, editId)
          }
          case "activeRun":
            return handleGetActiveRun()
          case "cancelRun": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            return handleCancelRun()
          }
          default:
            return notFound("Unknown handler")
        }
      } catch (e: any) {
        console.error("API error:", e)
        return json({ error: e?.message ?? "Internal server error" }, 500)
      }
    },
  })
}

// Allow running standalone: bun run src/server.ts
if (import.meta.main) {
  const port = parseInt(process.env.PORT ?? "3141")
  const server = createApiServer(port)
  console.log(`API server on http://localhost:${server.port}`)
}

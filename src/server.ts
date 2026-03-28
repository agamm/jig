/**
 * Bun API server — opaque backend for the dashboard.
 *
 * Handles /api/* routes. Next.js rewrites /api/* here via next.config.ts.
 */
import { join } from "path"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { discoverJigs } from "./discover.js"
import { openDb, insertRun, getJigRuns, getRun, getLastRun } from "./db.js"
import { loadServerConfigs } from "./mcp/config.js"
import { formatDuration } from "./utils.js"
import { runJig, persist, isValidJigId } from "./runner.js"
import type { RunEvent } from "./run-events.js"

const TRIGGER_PARSE_MODEL = "minimax/minimax-m2.5:nitro"

const PROJECT_ROOT = join(import.meta.dir, "..")
const JIGS_DIR = join(PROJECT_ROOT, "jigs")
const SCHEMAS_DIR = join(PROJECT_ROOT, ".jig/schemas")

const editLocks = new Map<string, { editId: string; status: string; message?: string; createdAt: number }>()
/** Track tool calls per run for real-time progress. */
type LiveStep = { seq: number; label: string; status: "running" | "success" | "fail"; output?: string; connections?: string[]; durationMs?: number; error?: string }
const runProgress = new Map<number, { completedTools: string[]; activeTools: string[]; steps: LiveStep[]; error?: string; done?: boolean; output?: string; readOnly?: Record<string, boolean> }>()
/** Only one run at a time (spinner + dryRun are global singletons). */
let activeRunId: number | null = null
let activeRunJigId: string | null = null
let activeRunDryRun = false

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function prettifyId(id: string): string {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

/** Extract params from jig source code — regex fallback for when import isn't possible. */
function extractParams(code: string): Record<string, string> {
  const m = code.match(/params\s*:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s)
  if (!m) return {}
  const params: Record<string, string> = {}
  const entries = m[1].matchAll(/(\w+)\s*:\s*["'`]([^"'`]*)["'`]/g)
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

/** Parse human-readable trigger text back into a JigTrigger object. */
function textToTrigger(text: string): { type: string; cron?: string; minutes?: number; source?: string } | null {
  const t = text.trim()
  if (!t) return null

  // Exact matches
  if (/^manual$/i.test(t)) return { type: "manual" }
  if (/^webhook$/i.test(t)) return { type: "webhook" }

  // "Every Xm" or "Every X minutes"
  const intervalMatch = t.match(/^every\s+(\d+)\s*m(?:in(?:ute)?s?)?$/i)
  if (intervalMatch) return { type: "interval", minutes: parseInt(intervalMatch[1]) }

  // Day name mapping
  const dayMap: Record<string, number> = { sun: 0, sunday: 0, mon: 1, monday: 1, tue: 2, tuesday: 2, wed: 3, wednesday: 3, thu: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6 }

  // Named time aliases
  const timeAlias: Record<string, [number, number]> = {
    morning: [9, 0], noon: [12, 0], afternoon: [14, 0], evening: [18, 0], night: [21, 0], midnight: [0, 0],
  }

  // Parse time from string — returns [hour, minute] or null
  function parseTime(s: string): [number, number] | null {
    const alias = timeAlias[s.trim().toLowerCase()]
    if (alias) return alias
    // "9am", "9:30pm", "14:00", "2pm"
    const m = s.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/i)
    if (!m) return null
    let h = parseInt(m[1])
    const min = m[2] ? parseInt(m[2]) : 0
    if (m[3]?.toLowerCase() === "pm" && h < 12) h += 12
    if (m[3]?.toLowerCase() === "am" && h === 12) h = 0
    return [h, min]
  }

  // "Daily HH:MM" or "every day at HH:MM"
  const dailyMatch = t.match(/^(?:daily|every\s+day(?:\s+at)?)\s+(.+)$/i)
  if (dailyMatch) {
    const time = parseTime(dailyMatch[1])
    if (time) return { type: "cron", cron: `${time[1]} ${time[0]} * * *` }
  }

  // "Mon 8:00" / "Mon, Fri 9:00" / "every monday at 9am" / "every week on monday morning"
  const timeAliasPattern = Object.keys(timeAlias).join("|")
  const dayTimeMatch = t.match(new RegExp(`^(?:every\\s+(?:week\\s+on\\s+)?)?([a-z, ]+?)(?:\\s+at)?\\s+(\\d{1,2}(?::\\d{2})?\\s*(?:am|pm)?|${timeAliasPattern})\\s*$`, "i"))
  if (dayTimeMatch) {
    const dayPart = dayTimeMatch[1].toLowerCase().replace(/\s+/g, "")
    const dayNames = dayPart.split(",").map(d => d.trim())
    const dayNums = dayNames.map(d => dayMap[d]).filter(d => d !== undefined)
    if (dayNums.length > 0) {
      const time = parseTime(dayTimeMatch[2])
      if (time) return { type: "cron", cron: `${time[1]} ${time[0]} * * ${dayNums.join(",")}` }
    }
  }

  // "X of month HH:MM" or "every month on the Xth at HH:MM"
  const monthMatch = t.match(/^(?:every\s+(?:month\s+on\s+(?:the\s+)?)?)?(\d{1,2})(?:st|nd|rd|th)?\s+(?:of\s+(?:the\s+)?month\s+)?(?:at\s+)?(.+)$/i)
  if (monthMatch) {
    const time = parseTime(monthMatch[2])
    if (time) return { type: "cron", cron: `${time[1]} ${time[0]} ${monthMatch[1]} * *` }
  }

  // "On <source>" → event trigger
  const eventMatch = t.match(/^on\s+(.+)$/i)
  if (eventMatch) return { type: "event", source: eventMatch[1].trim() }

  return null
}

type TriggerResult = { type: string; cron?: string; minutes?: number; source?: string; approximate?: boolean; note?: string }

/** LLM fallback for trigger text that the regex parser can't handle. */
async function textToTriggerLLM(text: string): Promise<TriggerResult | null> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) return null
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: TRIGGER_PARSE_MODEL,
        max_tokens: 2000,
        messages: [
          { role: "system", content: `Convert the user's scheduling description into a JSON trigger object. Return ONLY valid JSON, no explanation.

Possible formats:
- { "type": "cron", "cron": "<5-field cron expression>" }
- { "type": "interval", "minutes": <number> }
- { "type": "manual" }
- { "type": "webhook" }
- { "type": "event", "source": "<source name>" }

If the request CANNOT be exactly represented in standard 5-field cron (e.g. "odd weeks", "every 3rd Tuesday", "random times"), return the closest approximation AND set "approximate": true with a "note" explaining what was lost.

Examples:
"every friday at 9am" → { "type": "cron", "cron": "0 9 * * 5" }
"twice a day" → { "type": "cron", "cron": "0 9,17 * * *" }
"every 30 minutes" → { "type": "interval", "minutes": 30 }
"odd week tuesdays at 9am" → { "type": "cron", "cron": "0 9 * * 2", "approximate": true, "note": "Cron cannot express odd/even weeks — this will run every Tuesday" }` },
          { role: "user", content: text },
        ],
      }),
    })
    const data = await res.json() as any
    const content = data.choices?.[0]?.message?.content?.trim()
    if (!content) return null
    const parsed = JSON.parse(content.replace(/^```json?\s*|\s*```$/g, ""))
    if (parsed?.type) return parsed
    return null
  } catch (e) {
    console.error("[trigger-llm]", e)
    return null
  }
}

/** Serialize a trigger object into source code text. */
function triggerToSource(trigger: { type: string; cron?: string; minutes?: number; source?: string; filter?: string }): string {
  switch (trigger.type) {
    case "cron": return `{ type: "cron", cron: ${JSON.stringify(trigger.cron)} }`
    case "interval": return `{ type: "interval", minutes: ${trigger.minutes} }`
    case "event": return trigger.filter
      ? `{ type: "event", source: ${JSON.stringify(trigger.source)}, filter: ${JSON.stringify(trigger.filter)} }`
      : `{ type: "event", source: ${JSON.stringify(trigger.source)} }`
    case "manual": return `{ type: "manual" }`
    case "webhook": return `{ type: "webhook" }`
    default: return `{ type: "manual" }`
  }
}

/** Replace the trigger object in a jig source file. Returns updated code or null if no trigger found. */
function replaceTriggerInSource(code: string, newTrigger: string): string | null {
  const triggerRe = /trigger\s*:\s*\{[^}]*\}/
  if (!triggerRe.test(code)) return null
  return code.replace(triggerRe, `trigger: ${newTrigger}`)
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

async function buildJigResponse(id: string, entities: string[], runLimit: number, includeSteps = false) {
  const grouped = entities.length > 0
  const filePath = getJigFilePath(id, grouped ? entities[0] : undefined)
  let code = ""
  try { if (filePath) code = readFileSync(filePath, "utf-8") } catch {}

  const entity = grouped ? entities[0] : null
  let runs: ReturnType<typeof getJigRuns> = []
  try { runs = getJigRuns(id, undefined, runLimit) } catch {}

  // Sparkline from last 7 runs' durations (normalized).
  const recentDurations = runs.slice(0, 7).map((r) => r.duration_ms ?? 0).reverse()
  const maxDur = Math.max(...recentDurations, 1)
  const sparkline = recentDurations.map((d) => Math.round((d / maxDur) * 100))

  // Import definition for params and step scan; read trigger from source text
  // (source text is always fresh from disk, while import() may be Bun-cached)
  let params: Record<string, string> = {}
  let trigger = code ? extractTrigger(code) : ""
  let steps: { num: number; name: string; connections: string[] }[] = []
  if (filePath) {
    try {
      const mod = await import(filePath)
      const def = mod.default
      if (def?.options) {
        params = def.options.params ?? {}
      }
      // Steps from cache (instant). If miss, returned empty — dashboard fetches /steps endpoint.
      if (includeSteps && def?.handler && code) {
        const { getStepCache } = await import("./db.js")
        const hasher = new Bun.CryptoHasher("sha256")
        hasher.update(code)
        const cached = getStepCache(id, entity, hasher.digest("hex"))
        if (cached) steps = cached
      }
    } catch {
      params = extractParams(code)
      trigger = extractTrigger(code)
    }
  }

  return {
    id,
    name: prettifyId(id),
    trigger,
    status: deriveStatus(id),
    running: activeRunJigId === id && !activeRunDryRun,
    grouped,
    entityCount: grouped ? entities.length : undefined,
    entities: grouped ? buildEntityList(id, entities) : undefined,
    sparkline,
    steps,
    code: grouped ? "" : code,
    runs: formatRuns(runs),
    params,
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
  const jigs = await Promise.all(
    [...discovered.entries()].map(([id, entities]) => buildJigResponse(id, entities, 10))
  )
  return json(jigs)
}

async function handleGetJig(id: string): Promise<Response> {
  const discovered = discoverJigs(JIGS_DIR)
  if (!discovered.has(id)) return notFound(`Jig not found: ${id}`)
  return json(await buildJigResponse(id, discovered.get(id)!, 20, true))
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

  // Pre-run checks
  const connectionsDir = join(PROJECT_ROOT, ".jig/connections")
  if (!existsSync(join(connectionsDir, "index.ts"))) {
    return json({ error: "No connections found. Run 'jig connect <server>' first." }, 400)
  }

  // Only one run at a time — spinner and dryRun are global singletons.
  if (activeRunId !== null) return json({ error: "A run is already in progress" }, 409)

  // Only persist real runs — dry runs are ephemeral
  const runId = dryRun ? -1 : insertRun(id, entity, Object.keys(params).length > 0 ? params : undefined)
  activeRunId = runId
  activeRunJigId = id
  activeRunDryRun = dryRun
  runProgress.set(runId, { completedTools: [], activeTools: [], steps: [] })

  const startTime = Date.now()
  const persistHandler = !dryRun ? persist(runId, startTime) : null

  ;(async () => {
    try {
      await runJig(jigPath, params, (event: RunEvent) => {
        const p = runProgress.get(runId)
        if (p) {
          if (event.type === "step-start") { p.steps.push({ seq: event.seq, label: event.label, status: "running" }) }
          if (event.type === "step-done") {
            const s = p.steps.find(s => s.seq === event.seq)
            if (s) { s.status = event.status; s.output = event.output; s.connections = event.connections; s.durationMs = event.durationMs; s.error = event.error }
          }
          if (event.type === "tool") { p.completedTools = event.completed; p.activeTools = event.active; if (event.readOnly) p.readOnly = event.readOnly }
          if (event.type === "done") { p.done = true; p.output = event.output; p.activeTools = [] }
          if (event.type === "error") { p.done = true; p.error = event.message; p.activeTools = [] }
        }
        persistHandler?.(event)
      }, { dryRun, silent: true })
    } finally {
      const p = runProgress.get(runId)
      storeResult(runId, {
        status: p?.error ? "fail" : p?.done ? "success" : "fail",
        error: p?.error,
        output: p?.output,
        completedTools: p?.completedTools ?? [],
        steps: p?.steps ?? [],
        readOnly: p?.readOnly,
      })
      activeRunId = null
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
  const label = activeRunDryRun ? "Dry run" : `Run #${runId}`
  const jigName = activeRunJigId ?? "unknown"
  process.stderr.write(`\n\x1b[33m${label} of ${jigName} cancelled by user\x1b[0m\n`)
  // Abort via spinner — fires AbortSignal wired into all LLM calls
  const { spinner } = await import("./sdk/spinner.js")
  spinner.abort()
  return json({ ok: true, runId })
}

/** Recent run results — kept for 60s so the dashboard never misses them. */
const recentResults = new Map<number, { data: any; expiresAt: number }>()

function storeResult(runId: number, data: any) {
  recentResults.set(runId, { data, expiresAt: Date.now() + 60_000 })
  // Evict expired entries
  const now = Date.now()
  for (const [id, r] of recentResults) {
    if (now > r.expiresAt) recentResults.delete(id)
  }
}

async function handleGetActiveRun(): Promise<Response> {
  if (activeRunId !== null) {
    const progress = runProgress.get(activeRunId)
    return json({
      active: !progress?.done,
      runId: activeRunId,
      completedTools: progress?.completedTools ?? [],
      activeTools: progress?.activeTools ?? [],
      steps: progress?.steps ?? [],
      readOnly: progress?.readOnly,
      error: progress?.error,
      output: progress?.output,
      status: progress?.error ? "fail" : progress?.done ? "success" : "running",
    })
  }
  // No active run — check for recent result (60s TTL, not consumed)
  const latest = [...recentResults.entries()]
    .filter(([, r]) => Date.now() < r.expiresAt)
    .sort((a, b) => b[1].expiresAt - a[1].expiresAt)[0]
  if (latest) {
    return json({ active: false, runId: latest[0], ...latest[1].data })
  }
  return json({ active: false })
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

async function handleGetSteps(id: string, body: any): Promise<Response> {
  const discovered = discoverJigs(JIGS_DIR)
  if (!discovered.has(id)) return notFound(`Jig not found: ${id}`)

  const entity = body?.entity as string | undefined
  const filePath = getJigFilePath(id, entity)
  if (!filePath) return notFound(`Jig file not found`)

  let code: string
  try { code = readFileSync(filePath, "utf-8") } catch { return notFound("Jig file not readable") }

  try {
    const mod = await import(filePath)
    const def = mod.default
    if (!def?.handler) return json({ steps: [] })

    const { deriveSteps } = await import("./derive-steps.js")
    const steps = await deriveSteps(def, id, entity ?? null, code)
    return json({ steps })
  } catch (e: any) {
    return json({ steps: [], error: e?.message }, 500)
  }
}

async function handleUpdateTrigger(id: string, body: any): Promise<Response> {
  const triggerText = body?.trigger as string
  if (!triggerText) return json({ error: "Missing trigger text" }, 400)

  const discovered = discoverJigs(JIGS_DIR)
  if (!discovered.has(id)) return notFound(`Jig not found: ${id}`)

  const entities = discovered.get(id)!
  const filePath = getJigFilePath(id, entities.length > 0 ? entities[0] : undefined)
  if (!filePath) return notFound("Jig file not found")

  const trigger = textToTrigger(triggerText) ?? await textToTriggerLLM(triggerText)
  if (!trigger) return json({ error: `Could not parse trigger: "${triggerText}"` }, 400)

  let code: string
  try { code = readFileSync(filePath, "utf-8") } catch { return notFound("Jig file not readable") }

  const updated = replaceTriggerInSource(code, triggerToSource(trigger))
  if (!updated) return json({ error: "Could not find trigger in source file" }, 400)

  try { writeFileSync(filePath, updated) } catch {
    return json({ error: "Failed to write trigger to source file" }, 500)
  }

  // Return the new human-readable trigger text so the dashboard can update
  const newTriggerText = trigger.type === "cron" && trigger.cron ? cronToText(trigger.cron)
    : trigger.type === "interval" && trigger.minutes ? `Every ${trigger.minutes}m`
    : trigger.type === "event" && trigger.source ? `On ${trigger.source}`
    : trigger.type === "manual" ? "Manual"
    : trigger.type === "webhook" ? "Webhook"
    : triggerText
  const result: Record<string, any> = { ok: true, trigger: newTriggerText }
  if (trigger.approximate) result.warning = trigger.note || "This is an approximation — cron cannot express the exact schedule"
  return json(result)
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
  if (jigMatch) {
    if (!isValidJigId(decodeURIComponent(jigMatch[1]))) return null
    return { handler: "getJig", params: { id: decodeURIComponent(jigMatch[1]) } }
  }

  const runMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/run$/)
  if (runMatch) {
    if (!isValidJigId(decodeURIComponent(runMatch[1]))) return null
    return { handler: "runJig", params: { id: decodeURIComponent(runMatch[1]) } }
  }

  const runDetailMatch = pathname.match(/^\/api\/runs\/(\d+)$/)
  if (runDetailMatch) return { handler: "getRun", params: { id: runDetailMatch[1] } }

  const stepsMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/steps$/)
  if (stepsMatch) {
    if (!isValidJigId(decodeURIComponent(stepsMatch[1]))) return null
    return { handler: "getSteps", params: { id: decodeURIComponent(stepsMatch[1]) } }
  }

  const triggerMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/trigger$/)
  if (triggerMatch) {
    if (!isValidJigId(decodeURIComponent(triggerMatch[1]))) return null
    return { handler: "updateTrigger", params: { id: decodeURIComponent(triggerMatch[1]) } }
  }

  const editMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/edit$/)
  if (editMatch) {
    if (!isValidJigId(decodeURIComponent(editMatch[1]))) return null
    return { handler: "editJig", params: { id: decodeURIComponent(editMatch[1]) } }
  }

  const editStatusMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/edit-status$/)
  if (editStatusMatch) {
    if (!isValidJigId(decodeURIComponent(editStatusMatch[1]))) return null
    return { handler: "editStatus", params: { id: decodeURIComponent(editStatusMatch[1]) } }
  }

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
          case "getSteps": {
            const body = req.method === "POST" ? await req.json().catch(() => ({})) : {}
            return handleGetSteps(route.params.id, body)
          }
          case "updateTrigger": {
            if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
            const body = await req.json().catch(() => ({}))
            return handleUpdateTrigger(route.params.id, body)
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

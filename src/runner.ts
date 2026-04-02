/**
 * Jig runner — the single execution path for both CLI and dashboard.
 *
 * Handles the full lifecycle: import → validate → run → collect results.
 * Callers observe execution via the onEvent callback.
 */
import { join } from "path"
import { appendFile } from "node:fs/promises"
import type { RunRecorder } from "./sdk/context.js"
import { SkipError } from "./sdk/context.js"
import type { RunEvent } from "./run-events.js"
import { insertStep, completeStep, completeRun } from "./db.js"
import { dryRunContext } from "./sdk/dryrun.js"

// --- Debug log (async, queued) ---
const LOG_PATH = join(import.meta.dir, "../jig_debug.log")
let _logQueue: string[] = []
let _logFlushPending = false

function debug(msg: string) {
  _logQueue.push(`${new Date().toISOString()} ${msg}\n`)
  if (!_logFlushPending) {
    _logFlushPending = true
    queueMicrotask(flushLog)
  }
}

async function flushLog() {
  const batch = _logQueue
  _logQueue = []
  _logFlushPending = false
  try { await appendFile(LOG_PATH, batch.join("")) } catch {}
}

// --- Runner ---
export interface RunResult {
  output: string
  tools: string[]
  durationMs: number
  error?: string
  skipped?: boolean
}

/**
 * Run a jig file with the given params.
 *
 * @param jigPath  Absolute path to the jig .ts file
 * @param params   Resolved params (prompting is the caller's job)
 * @param onEvent  Callback for every run event — progress, steps, errors, completion
 * @param options  dryRun: stub tool calls; silent: suppress console output
 */
export async function runJig(
  jigPath: string,
  params: Record<string, string>,
  onEvent: (e: RunEvent) => void,
  options?: { dryRun?: boolean; silent?: boolean; signal?: AbortSignal }
): Promise<RunResult> {
  const { dryRun, silent } = options ?? {}

  // Wrap entire execution in dryRun context (AsyncLocalStorage)
  // Generated tool functions read isDryRun() which checks this context
  const signal = options?.signal
  return dryRunContext.run(dryRun ?? false, () =>
    _runJig(jigPath, params, onEvent, { dryRun: dryRun ?? false, silent: silent ?? false, signal })
  )
}

async function _runJig(
  jigPath: string,
  params: Record<string, string>,
  onEvent: (e: RunEvent) => void,
  opts: { dryRun: boolean; silent: boolean; signal?: AbortSignal }
): Promise<RunResult> {
  const { dryRun, silent, signal } = opts
  const start = Date.now()
  const tag = dryRun ? "[dry-run]" : "[run]"
  const log = (msg: string) => debug(`${tag} ${msg}`)

  log(`start ${jigPath}`)

  // Wire spinner → onEvent for tool progress
  const { spinner } = await import("./sdk/spinner.js")
  spinner.reset(signal)
  let toolReadOnly: Record<string, boolean> | undefined
  spinner.setToolCallback((chain, current) => {
    onEvent({ type: "tool", completed: chain.slice(0, -1).flat(), active: [...current], ...(dryRun && toolReadOnly && { readOnly: toolReadOnly }) })
  })

  // Recorder bridges Context's step lifecycle → RunEvent stream
  const recorder: RunRecorder = {
    onStepStart(seq, label) { onEvent({ type: "step-start", seq, label }) },
    onStepDone(seq, output, status, ms, connections, err) {
      onEvent({ type: "step-done", seq, output, status, durationMs: ms, connections, error: err })
    },
    onOutput(text) { onEvent({ type: "output", text }) },
  }

  try {
    // --- Pre-run guards ---

    // 0. Validate source code patterns (before import to catch side effects)
    const source = await Bun.file(jigPath).text().catch(() => null)
    if (source) {
      const problems: string[] = []
      const stripped = source.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")

      if (/^\s*await\s+run\s*\(/m.test(stripped))
        problems.push("Jig calls run() at module level — remove it. The runner calls run() for you.")
      if (/^\s*process\.exit/m.test(stripped))
        problems.push("Jig calls process.exit() at module level — remove it.")
      if (/console\.log\s*\(/.test(stripped))
        problems.push("Use ctx.output() instead of console.log() — console.log bypasses the event stream.")
      if (/from\s+["'][.]{2}/.test(stripped))
        problems.push('Jig uses relative imports (../) — use "jig" and "jig/connections/" aliases instead.')
      if (!/export\s+default/.test(stripped))
        problems.push('Jig must have an export default — add "export default <jigName>".')

      if (problems.length > 0) {
        const error = `Jig validation failed:\n${problems.map(p => `  • ${p}`).join("\n")}`
        onEvent({ type: "error", message: error })
        return { output: "", tools: [], durationMs: Date.now() - start, error }
      }
    }

    // 1. Import jig (cache bust) — classified errors
    let mod: any
    try {
      mod = await import(`${jigPath}?_t=${Date.now()}_${Math.random().toString(36).slice(2)}`)
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      const error = msg.includes("Cannot find module")
        ? `Connection module missing. Run "jig connect" to regenerate.\n${msg}`
        : msg.includes("Export named")
        ? `SDK version mismatch. Run "git pull" and restart.\n${msg}`
        : `Failed to load jig: ${msg}`
      onEvent({ type: "error", message: error })
      return { output: "", tools: [], durationMs: Date.now() - start, error }
    }

    // 2. Validate definition shape
    const def = mod.default
    if (!def || typeof def.handler !== "function") {
      const error = "Jig must export a default JigDefinition (use jig() function)"
      onEvent({ type: "error", message: error })
      return { output: "", tools: [], durationMs: Date.now() - start, error }
    }

    // 3. Build readOnly map from tool definitions (for dry-run UI)
    const defTools = def.options?.tools ?? []
    if (defTools.length > 0) {
      toolReadOnly = {}
      for (const t of defTools) {
        const short = t._toolName.includes("__") ? t._toolName.split("__")[1] : t._toolName
        toolReadOnly[short] = t._readOnly ?? true
      }
    }

    // 4. Validate required params
    const required = Object.keys(def.options?.params ?? {})
    const missing = required.filter((k: string) => !params[k]?.trim())
    if (missing.length > 0) {
      const error = `Missing required params: ${missing.join(", ")}`
      onEvent({ type: "error", message: error })
      return { output: "", tools: [], durationMs: Date.now() - start, error }
    }

    // --- Run ---
    log(`executing handler (${def.name})`)
    const { run } = await import("./sdk/jig.js")
    const ctx = await run(def, params, { ...(silent && { silent: true }), recorder })

    // --- Post-run ---
    const tools = spinner.getTools()
    const output = ctx.getOutput().join("\n")
    const durationMs = Date.now() - start

    if (!dryRun && !output.trim()) {
      onEvent({ type: "output", text: "[warn] Jig produced no output" })
    }

    log(`done in ${(durationMs / 1000).toFixed(1)}s — ${tools.length} tools, ${output.length} chars output`)
    onEvent({ type: "done", tools, output, durationMs })
    return { output, tools, durationMs }

  } catch (e: any) {
    // Skip — handler called ctx.skip(), run should not be persisted
    if (e instanceof SkipError) {
      const durationMs = Date.now() - start
      log(`skipped: ${e.message}`)
      onEvent({ type: "skipped", reason: e.message })
      return { output: "", tools: [], durationMs, skipped: true }
    }

    // Extract detailed error info from OpenAI SDK / provider errors
    let error = e?.message ?? String(e)
    if (e?.status && e?.error) {
      const detail = typeof e.error === "object"
        ? (e.error.message || JSON.stringify(e.error))
        : String(e.error)
      error = `${e.status} ${detail}`
      log(`LLM error (${e.status}): ${detail}`)
      if (e.error?.metadata) log(`  metadata: ${JSON.stringify(e.error.metadata)}`)
    }
    const durationMs = Date.now() - start
    log(`error after ${(durationMs / 1000).toFixed(1)}s: ${error}`)
    onEvent({ type: "error", message: error })
    return { output: "", tools: [], durationMs, error }

  } finally {
    spinner.setToolCallback(null)
  }
}

/**
 * Creates an onEvent handler that persists run events to SQLite.
 * Use standalone or compose with other handlers in the onEvent callback.
 */
export function persist(runId: number, startTime: number): (e: RunEvent) => void {
  const steps = new Map<number, number>()
  return (event) => {
    switch (event.type) {
      case "step-start":
        steps.set(event.seq, insertStep(runId, event.seq, event.label))
        break
      case "step-done": {
        const sid = steps.get(event.seq)
        if (sid) completeStep(sid, event.output, event.status, event.durationMs, event.connections, event.error)
        break
      }
      case "done":
        completeRun(runId, "success", event.durationMs)
        break
      case "error":
        completeRun(runId, "fail", Date.now() - startTime, event.message)
        break
    }
  }
}

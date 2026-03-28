/**
 * Jig run worker — executes a jig in an isolated subprocess.
 *
 * Args: <jigPath> [--dry-run] [--params <json>]
 *
 * Outputs JSON lines to stdout for the server to parse:
 *   { type: "tool", tools: [...] }          — tool call progress
 *   { type: "output", text: "..." }         — jig output
 *   { type: "done", tools: [...] }          — completed, all tools called
 *   { type: "error", message: "..." }       — failed
 */
const args = process.argv.slice(2)
const jigPath = args[0]
const dryRun = args.includes("--dry-run")
const paramsIdx = args.indexOf("--params")

function emit(data: any) { process.stdout.write(JSON.stringify(data) + "\n") }

if (!jigPath) { emit({ type: "error", message: "No jig path provided" }); process.exit(1) }

let params: Record<string, string> = {}
try {
  params = paramsIdx >= 0 ? JSON.parse(args[paramsIdx + 1]) : {}
} catch {
  emit({ type: "error", message: "Invalid params JSON" }); process.exit(1)
}

;(async () => {
  try {
    if (dryRun) {
      const { setDryRun } = await import("./sdk/dryrun.js")
      setDryRun(true)
    }

    // Hook spinner for tool progress
    const { spinner } = await import("./sdk/spinner.js")
    spinner.setToolCallback((chain, current) => {
      const completed = chain.slice(0, -1).flat()
      emit({ type: "tool", completed, active: [...current] })
    })

    // Pre-flight: check that the jig can be imported (catches stale connection modules)
    let mod: any
    try {
      mod = await import(jigPath)
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      if (msg.includes("Cannot find module")) {
        emit({ type: "error", message: `Connection module missing. Run "jig connect" to regenerate.\n${msg}` })
      } else if (msg.includes("Export named")) {
        emit({ type: "error", message: `SDK version mismatch. Run "git pull upstream main" and restart.\n${msg}` })
      } else {
        emit({ type: "error", message: `Failed to load jig: ${msg}` })
      }
      process.exit(1)
    }
    const { run } = await import("./sdk/jig.js")
    const def = mod.default
    if (!def || typeof def.handler !== "function") {
      emit({ type: "error", message: "Jig file must export a default JigDefinition (use jig() function)" })
      process.exit(1)
    }

    // Silence ctx.log() — it writes to stdout which would corrupt our JSON protocol
    const ctx = await run(def, params, { silent: true })

    // Collect results
    const output = ctx.getOutput().join("\n")
    const progress = spinner as any
    // Get final tool list from spinner batches
    const allBatches = [...(progress.batches ?? []), ...(progress.currentBatch ? [progress.currentBatch] : [])]
    const allTools = allBatches.flat()

    emit({ type: "done", tools: allTools, output })
  } catch (e: any) {
    emit({ type: "error", message: e?.message ?? String(e) })
  }
  process.exit(0)
})()

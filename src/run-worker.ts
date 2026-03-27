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
const params = paramsIdx >= 0 ? JSON.parse(args[paramsIdx + 1]) : {}

if (!jigPath) { console.error("Usage: bun run-worker.ts <jigPath> [--dry-run] [--params <json>]"); process.exit(1) }

function emit(data: any) { process.stdout.write(JSON.stringify(data) + "\n") }

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

    const { run } = await import("./sdk/jig.js")
    const mod = await import(jigPath)
    const def = mod.default

    const ctx = await run(def, params)

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

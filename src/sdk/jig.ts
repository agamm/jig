import { Context, runContext, stepScanContext, type RunRecorder } from "./context.js"

/**
 * A typed MCP tool function. Generated at runtime by createConnection(),
 * typed at compile time by typegen.
 */
export type JigTool<TInput = unknown, TOutput = unknown> = {
  _serverName: string
  _toolName: string
  _readOnly?: boolean
  (params: TInput): Promise<TOutput>
}

export type JigTrigger =
  | { type: "cron"; cron: string }          // e.g. "0 8 * * 1" = every monday 8am
  | { type: "interval"; minutes: number }    // e.g. 30 = every 30 minutes
  | { type: "event"; source: string; filter?: string }
  | { type: "manual" }
  | { type: "webhook" }

export type JigOptions = {
  trigger: JigTrigger
  params?: Record<string, string>
  tools?: JigTool<any, any>[]
}

export type JigDefinition = {
  name: string
  options: JigOptions
  handler: (ctx: Context) => Promise<void>
}

/**
 * Define a jig — a deterministic unit of work.
 */
export function jig(
  name: string,
  options: JigOptions,
  handler: (ctx: Context) => Promise<void>
): JigDefinition {
  return { name, options, handler }
}

/**
 * Run a jig with the given params. Pure execution — no I/O.
 * Param prompting is the caller's responsibility (CLI uses io.ask, dashboard uses a form).
 * Returns the context so callers can access captured output.
 */
export async function run(
  definition: JigDefinition,
  params: Record<string, string> = {},
  options?: { silent?: boolean; recorder?: RunRecorder }
): Promise<Context> {
  const toolNames = (definition.options.tools ?? []).map((t) => t._toolName)
  const ctx = new Context(params, toolNames)
  if (options?.silent) ctx.setSink(() => {})
  if (options?.recorder) ctx.setRecorder(options.recorder)
  return runContext.run(ctx, async () => {
    try {
      await definition.handler(ctx)
      ctx.finalize()
    } catch (e) {
      ctx.finalize(e)
      throw e
    }
    return ctx
  })
}

export type ScannedStep = { seq: number; label: string; connections: string[] }
export type ScannedStepTool = { connection: string; name: string; readOnly: boolean }
export type ScannedStepWithTools = { seq: number; label: string; connections: string[]; tools: ScannedStepTool[] }

/**
 * Scan a jig handler to collect step labels without executing anything.
 * Runs the handler in step-scan mode: agent/llm/tool calls record their step
 * and return stubs. If the handler crashes on a stub value, we still return
 * whatever steps were recorded before the crash.
 */
export async function scanSteps(definition: JigDefinition): Promise<ScannedStepWithTools[]> {
  const steps: ScannedStepWithTools[] = []
  const toolNames = (definition.options.tools ?? []).map((t) => t._toolName)
  // Empty params — handlers that branch on ctx.params will follow the falsy/default path.
  // This is acceptable: scan captures the "typical" step shape, not all possible branches.
  const ctx = new Context({}, toolNames)
  ctx.setSink(() => {})
  ctx.setRecorder({
    onStepStart(seq, label) { steps.push({ seq, label, connections: [], tools: [] }) },
    onStepDone(seq, _output, _status, _ms, connections) {
      const s = steps.find(s => s.seq === seq)
      if (s) {
        s.connections = connections
        s.tools = ctx.getStepTools()
      }
    },
  })

  await stepScanContext.run(true, () =>
    runContext.run(ctx, async () => {
      try {
        await definition.handler(ctx)
      } catch (e) {
        // If we recorded steps, this is likely a stub value crash (expected).
        // If zero steps, the handler failed before any SDK call — real error.
        if (steps.length === 0) {
          console.warn("Step scan failed before recording any steps:", (e as Error)?.message)
        }
      }
      ctx.finalize()
    })
  )

  return steps
}

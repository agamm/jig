import { Context, runContext, type RunRecorder } from "./context.js"

/**
 * A typed MCP tool function. Generated at runtime by createConnection(),
 * typed at compile time by typegen.
 */
export type JigTool<TInput = unknown, TOutput = any> = {
  _serverName: string
  _toolName: string
  _readOnly?: boolean
  (params: TInput): Promise<TOutput>
}

export type JigTrigger =
  | { type: "cron"; cron: string }          // e.g. "0 8 * * 1" = every monday 8am
  | { type: "calendar"; minutesBefore: number } // fires before each calendar event
  | { type: "email" }                       // fires on mail to the jig's own inbox
  | { type: "manual" }
  | { type: "webhook" }

export type JigOptions = {
  trigger: JigTrigger
  tools?: JigTool<any, any>[]
  /**
   * Default model for this jig's `llm()` and `agent()` calls (OpenRouter id).
   * `ctx.step(..., { model })` and `llm(..., { model })` win above it; unset
   * falls back to the global main model.
   */
  model?: string
  /** Whole-run watchdog in ms. Omit for the global default (30 minutes). */
  runTimeoutMs?: number
  /** Ceiling per MCP tool call in ms. Omit for the global default (5 minutes). */
  toolTimeoutMs?: number
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
 * `params` are runtime inputs only (for example webhook/manual payloads).
 * Returns the context so callers can access captured output.
 */
export async function run(
  definition: JigDefinition,
  params: Record<string, unknown> = {},
  options?: {
    silent?: boolean
    recorder?: RunRecorder
    signal?: AbortSignal
    jigId?: string
  }
): Promise<Context> {
  const ctx = new Context(params, {
    signal: options?.signal,
    toolTimeoutMs: definition.options.toolTimeoutMs,
    jigId: options?.jigId,
  })
  if (options?.silent) ctx.setSink(() => {})
  if (options?.recorder) ctx.setRecorder(options.recorder)
  // Model precedence, high to low: llm({ model }) > ctx.step({ model }) > jig({ model }) > global main model.
  ctx.setBaseModel(definition.options.model ?? null)
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

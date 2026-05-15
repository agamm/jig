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
  | { type: "manual" }
  | { type: "webhook" }

export type JigOptions = {
  trigger: JigTrigger
  tools?: JigTool<any, any>[]
  /**
   * Default LLM model for this jig's `llm()` and `agent()` calls. Lower
   * precedence than per-step or per-call overrides, and lower than the
   * dashboard's runtime override. Falls back to the global default if unset.
   * Format: OpenRouter model id, e.g. "anthropic/claude-haiku-4.5".
   */
  model?: string
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
  options?: { silent?: boolean; recorder?: RunRecorder; signal?: AbortSignal; modelOverride?: string | null }
): Promise<Context> {
  const toolNames = (definition.options.tools ?? []).map((t) => t._toolName)
  const ctx = new Context(params, toolNames, options?.signal)
  if (options?.silent) ctx.setSink(() => {})
  if (options?.recorder) ctx.setRecorder(options.recorder)
  // Precedence (low → high inside ctx, with per-call/step overrides above):
  //   global default ← jig code ← dashboard override
  // Step model is pushed/popped inside ctx.step; per-call passes options.model.
  ctx.setBaseModel(options?.modelOverride ?? definition.options.model ?? null)
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

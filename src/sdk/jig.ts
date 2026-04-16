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
  options?: { silent?: boolean; recorder?: RunRecorder; signal?: AbortSignal }
): Promise<Context> {
  const toolNames = (definition.options.tools ?? []).map((t) => t._toolName)
  const ctx = new Context(params, toolNames, options?.signal)
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

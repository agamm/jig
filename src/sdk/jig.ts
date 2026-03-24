import { Context } from "./context.js"

/**
 * A typed MCP tool function. Generated at runtime by createConnection(),
 * typed at compile time by typegen.
 */
export type JigTool<TInput = unknown, TOutput = unknown> = {
  _serverName: string
  _toolName: string
  (params: TInput): Promise<TOutput>
}

export type JigOptions = {
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
  options?: { silent?: boolean }
): Promise<Context> {
  const toolNames = (definition.options.tools ?? []).map((t) => t._toolName)
  const ctx = new Context(params, toolNames)
  if (options?.silent) ctx.setSink(() => {})
  await definition.handler(ctx)
  return ctx
}

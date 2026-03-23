import { createInterface } from "node:readline/promises"
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
 * Run a jig. Prompts for missing params in interactive mode.
 */
export async function run(
  definition: JigDefinition,
  params: Record<string, string> = {}
): Promise<void> {
  const paramDefs = definition.options.params ?? {}
  const missing = Object.keys(paramDefs).filter((name) => !params[name])

  if (missing.length > 0) {
    if (!process.stdin.isTTY) {
      const list = missing.map((n) => `  ${n} — ${paramDefs[n]}`).join("\n")
      throw new Error(`Missing required params:\n${list}`)
    }

    const rl = createInterface({ input: process.stdin, output: process.stdout })
    for (const name of missing) {
      const answer = await rl.question(`${name} (${paramDefs[name]}): `)
      if (!answer.trim()) {
        rl.close()
        throw new Error(`Required param "${name}" cannot be empty`)
      }
      params[name] = answer.trim()
    }
    rl.close()
  }

  const toolNames = (definition.options.tools ?? []).map((t) => t._toolName)
  const ctx = new Context(params, toolNames)
  await definition.handler(ctx)
}

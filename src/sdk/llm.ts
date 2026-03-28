import { join } from "path"
import OpenAI from "openai"
import type { JigTool } from "./jig.js"
import { spinner } from "./spinner.js"
import { runContext, isStepScan, truncLabel } from "./context.js"

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-5"
const MAX_TOOL_ROUNDS = 15

let _client: OpenAI | null = null

export function getClient(): OpenAI {
  if (!_client) {
    const apiKey = process.env.OPENROUTER_API_KEY
    if (!apiKey) throw new Error("OPENROUTER_API_KEY not set. Get one at https://openrouter.ai/keys and add to .env")
    _client = new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey })
  }
  return _client
}

/**
 * Call an LLM for content generation or judgment. No tool access.
 *
 * Plain mode: returns a string.
 * Structured mode (schema option): returns a parsed object.
 */
export async function llm<T = string>(
  prompt: string,
  data: Record<string, any>,
  options?: { schema?: Record<string, string>; model?: string; maxTokens?: number }
): Promise<T> {
  const ctx = runContext.getStore()
  if (ctx && !ctx.inAgent) ctx.step(truncLabel(prompt))

  if (isStepScan()) return (options?.schema ? {} : "") as T

  const model = options?.model ?? DEFAULT_MODEL
  const maxTokens = options?.maxTokens ?? 4096
  const userContent = `${prompt}\n\nData:\n${JSON.stringify(data, null, 2)}`

  if (options?.schema) {
    const properties: Record<string, any> = {}
    for (const [key, type] of Object.entries(options.schema)) {
      properties[key] = { type }
    }

    const response = await getClient().chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: userContent }],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "response",
          strict: true,
          schema: {
            type: "object",
            properties,
            required: Object.keys(options.schema),
            additionalProperties: false,
          },
        },
      },
    }, { signal: spinner.signal })

    const text = response.choices[0]?.message?.content
    if (!text) throw new Error("LLM returned empty response")
    return JSON.parse(text) as T
  }

  const response = await getClient().chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: userContent }],
  }, { signal: spinner.signal })

  const text = response.choices[0]?.message?.content
  if (!text) throw new Error("LLM returned empty response")
  return text as T
}

/**
 * Ask an LLM to accomplish a task using the provided tools.
 * The LLM decides which tools to call and how to use the results.
 *
 * This is the "bigger hatch" — the LLM has agency within the
 * bounded permission set of the tools array.
 *
 * With schema: returns structured output after tool calling is done.
 * Without schema: returns the final text response.
 */
export async function agent<T = string>(
  prompt: string,
  tools: JigTool<any, any>[],
  options?: { schema?: Record<string, string>; model?: string; maxTokens?: number }
): Promise<T> {
  const ctx = runContext.getStore()
  ctx?.step(truncLabel(prompt))
  // Record all connections this agent can use
  const connSet = new Set(tools.map(t => t._serverName))
  for (const c of connSet) ctx?.addConnection(c)

  if (isStepScan()) return (options?.schema ? {} : "") as T

  ctx?.enterAgent()

  const model = options?.model ?? DEFAULT_MODEL
  spinner.show("agent")

  try {
    return await runAgent<T>(prompt, tools, options)
  } finally {
    spinner.stop()
    ctx?.leaveAgent()
  }
}

async function runAgent<T>(
  prompt: string,
  tools: JigTool<any, any>[],
  options?: { schema?: Record<string, string>; model?: string; maxTokens?: number }
): Promise<T> {
  const model = options?.model ?? DEFAULT_MODEL
  const maxTokens = options?.maxTokens ?? 4096

  // Build tool mapping and OpenAI tool definitions
  const toolMap = new Map<string, JigTool<any, any>>()
  const toolDefs: OpenAI.ChatCompletionTool[] = []

  for (const tool of tools) {
    const qualifiedName = `${tool._serverName}__${tool._toolName}`
    toolMap.set(qualifiedName, tool)

    // Load the cached schema for this tool
    const schema = await loadToolSchema(tool._serverName, tool._toolName)
    toolDefs.push({
      type: "function",
      function: {
        name: qualifiedName,
        description: schema?.description ?? tool._toolName,
        parameters: schema?.inputSchema ?? { type: "object", properties: {} },
      },
    })
  }

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: "user", content: prompt },
  ]

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    if (spinner.aborted) throw new Error("Run cancelled")

    const response = await getClient().chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages,
      tools: toolDefs,
    }, { signal: spinner.signal })

    const message = response.choices[0]?.message
    if (!message) throw new Error("LLM returned empty response")

    messages.push(message)

    // If no tool calls, we're done — optionally structure the final response
    if (!message.tool_calls?.length) {
      if (options?.schema) {
        return await structureResponse(messages, options.schema, model, maxTokens)
      }
      return (message.content ?? "") as T
    }

    if (spinner.aborted) throw new Error("Run cancelled")

    // Execute all tool calls in parallel, report to spinner as a batch
    spinner.batch()
    const toolResults = await Promise.all(
      message.tool_calls.map(async (call) => {
        spinner.tool(call.function.name)
        const tool = toolMap.get(call.function.name)
        if (!tool) {
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: JSON.stringify({ error: `Unknown tool: ${call.function.name}` }),
          }
        }

        try {
          const args = JSON.parse(call.function.arguments)
          const result = await tool(args)
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: typeof result === "string" ? result : JSON.stringify(result),
          }
        } catch (e: any) {
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: JSON.stringify({ error: e.message }),
          }
        }
      })
    )

    messages.push(...toolResults)
  }

  throw new Error(`agent() exceeded ${MAX_TOOL_ROUNDS} tool rounds — possible loop`)
}

/**
 * Take the agent's final text response and restructure it via json_schema response_format.
 * One cheap LLM call — the content is already generated, just reformatting.
 */
async function structureResponse<T>(
  messages: OpenAI.ChatCompletionMessageParam[],
  schema: Record<string, string>,
  model: string,
  maxTokens: number = 4096
): Promise<T> {
  const properties: Record<string, any> = {}
  for (const [key, type] of Object.entries(schema)) {
    properties[key] = { type }
  }

  const response = await getClient().chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [
      ...messages,
      {
        role: "user",
        content: "Now format your response as the requested JSON structure.",
      },
    ],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "response",
        strict: true,
        schema: {
          type: "object",
          properties,
          required: Object.keys(schema),
          additionalProperties: false,
        },
      },
    },
  }, { signal: spinner.signal })

  const text = response.choices[0]?.message?.content
  if (!text) throw new Error("Structured response was empty")
  return JSON.parse(text)
}

/**
 * Load a tool's schema from the cached .jig/schemas/ directory.
 */
async function loadToolSchema(
  serverName: string,
  toolName: string
): Promise<{ description?: string; inputSchema?: any } | null> {
  try {
    const schemasPath = join(import.meta.dir, "../../.jig/schemas", `${serverName}.json`)
    const tools = await Bun.file(schemasPath).json()
    return tools.find((t: any) => t.name === toolName) ?? null
  } catch {
    return null
  }
}

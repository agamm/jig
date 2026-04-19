import { join } from "path"
import OpenAI from "openai"
import type { JigTool } from "./jig.js"
import { spinner } from "./spinner.js"
import { runContext } from "./context.js"
import { MAIN_MODEL } from "../config/models.js"
import { logSessionEvent } from "../debug/session-log.js"
import { requireOpenRouterApiKey } from "../config/openrouter.js"

const MAX_TOOL_ROUNDS = 30

// Don't cache the OpenAI client across calls: the API key can change at
// runtime (user updates it in the dashboard), and the credentials table read
// is cheap. Fresh client per call also avoids holding a stale key across an
// unlock/re-lock cycle.
export function getClient(): OpenAI {
  const apiKey = requireOpenRouterApiKey()
  return new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey })
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
  options?: { schema?: Record<string, string>; model?: string; maxTokens?: number; signal?: AbortSignal }
): Promise<T> {
  const ctx = runContext.getStore()
  const model = options?.model ?? MAIN_MODEL
  ctx?.addTool("llm", `llm(${model})`, true)
  const signal = options?.signal ?? ctx?.signal

  const maxTokens = options?.maxTokens ?? 4096
  const userContent = `${prompt}\n\nData:\n${JSON.stringify(data, null, 2)}`
  logSessionEvent({
    source: "sdk.llm",
    event: "request",
    mode: options?.schema ? "structured" : "plain",
    model,
    maxTokens,
    prompt,
    data,
    userContent,
    schema: options?.schema,
  })

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
    }, signal ? { signal } : undefined)

    const raw = response.choices[0]?.message?.content
    if (!raw) throw new Error("LLM returned empty response")
    // Strip backtick fences — many models wrap JSON in ```json ... ```
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
    const text = fenced ? fenced[1].trim() : raw.trim()
    const parsed = JSON.parse(text) as T
    logSessionEvent({
      source: "sdk.llm",
      event: "response",
      mode: "structured",
      model,
      raw,
      parsed,
      finishReason: response.choices[0]?.finish_reason,
      usage: response.usage,
    })
    return parsed
  }

  const response = await getClient().chat.completions.create({
    model,
    max_tokens: maxTokens,
    messages: [{ role: "user", content: userContent }],
  }, signal ? { signal } : undefined)

  const text = response.choices[0]?.message?.content
  if (!text) throw new Error("LLM returned empty response")
  logSessionEvent({
    source: "sdk.llm",
    event: "response",
    mode: "plain",
    model,
    output: text,
    finishReason: response.choices[0]?.finish_reason,
    usage: response.usage,
  })
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
  // Record all connections this agent can use
  const connSet = new Set(tools.map(t => t._serverName))
  for (const c of connSet) ctx?.addConnection(c)
  for (const tool of tools) {
    ctx?.addTool(tool._serverName, tool._toolName, tool._readOnly ?? true)
  }

  ctx?.enterAgent()

  const model = options?.model ?? MAIN_MODEL
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
  const model = options?.model ?? MAIN_MODEL
  const maxTokens = options?.maxTokens ?? 4096
  logSessionEvent({
    source: "sdk.agent",
    event: "start",
    model,
    maxTokens,
    prompt,
    schema: options?.schema,
    tools: tools.map((tool) => ({
      server: tool._serverName,
      tool: tool._toolName,
      readOnly: tool._readOnly ?? true,
    })),
  })

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
    logSessionEvent({
      source: "sdk.agent",
      event: "round-request",
      model,
      round,
      messages,
      tools: toolDefs,
    })

    const response = await getClient().chat.completions.create({
      model,
      max_tokens: maxTokens,
      messages,
      tools: toolDefs,
    }, { signal: spinner.signal })

    const message = response.choices[0]?.message
    if (!message) throw new Error("LLM returned empty response")
    logSessionEvent({
      source: "sdk.agent",
      event: "round-response",
      model,
      round,
      message,
      finishReason: response.choices[0]?.finish_reason,
      usage: response.usage,
    })

    messages.push(message)

    // If no tool calls, we're done — optionally structure the final response
    if (!message.tool_calls?.length) {
      if (options?.schema) {
        return await structureResponse(messages, options.schema, model, maxTokens)
      }
      logSessionEvent({
        source: "sdk.agent",
        event: "done",
        model,
        round,
        output: message.content ?? "",
      })
      return (message.content ?? "") as T
    }

    if (spinner.aborted) throw new Error("Run cancelled")

    // Execute all tool calls in parallel, report to spinner as a batch
    spinner.batch()
    const toolResults = await Promise.all(
      message.tool_calls.map(async (call) => {
        if (call.type !== "function") {
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: JSON.stringify({ error: `Unsupported tool call type: ${call.type}` }),
          }
        }
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
          logSessionEvent({
            source: "sdk.agent",
            event: "tool-result",
            model,
            round,
            tool: call.function.name,
            args,
            result,
          })
          return {
            role: "tool" as const,
            tool_call_id: call.id,
            content: typeof result === "string" ? result : JSON.stringify(result),
          }
        } catch (e: any) {
          logSessionEvent({
            source: "sdk.agent",
            event: "tool-error",
            model,
            round,
            tool: call.function.name,
            args: call.function.arguments,
            error: e,
          })
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

  const raw = response.choices[0]?.message?.content
  if (!raw) throw new Error("Structured response was empty")
  // Strip backtick fences — many models wrap JSON in ```json ... ```
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
  const text = fenced ? fenced[1].trim() : raw.trim()
  try {
    const parsed = JSON.parse(text)
    logSessionEvent({
      source: "sdk.agent",
      event: "structured-response",
      model,
      raw,
      parsed,
      usage: response.usage,
    })
    const missing = Object.keys(schema).filter(k => parsed[k] === undefined || parsed[k] === null)
    if (missing.length > 0) {
      console.error(`[llm] structureResponse missing keys: ${missing.join(", ")} — raw: ${text.slice(0, 200)}`)
    }
    return parsed
  } catch {
    throw new Error(`Failed to parse structured response: ${raw.slice(0, 300)}`)
  }
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

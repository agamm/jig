import { join } from "node:path"
import { existsSync, readFileSync } from "node:fs"
import { mkdir } from "node:fs/promises"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import type { ServerConfig } from "./config.js"
import { resolveToken } from "./config.js"
import { JigOAuthProvider } from "./auth.js"
import { PROJECT_ROOT, SCHEMAS_DIR } from "../config/paths.js"
import { runContext } from "../sdk/context.js"
import { USER_CANCELLED_MESSAGE } from "../run-cancel.js"

export type McpConnection = {
  client: Client
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport
  serverName: string
  config: ServerConfig
}

const toolSchemaCache = new Map<string, Map<string, Tool>>()

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(USER_CANCELLED_MESSAGE)
}

function bindAbortCleanup(
  signal: AbortSignal | undefined,
  cleanup: () => Promise<void> | void
): () => void {
  if (!signal) return () => {}

  const onAbort = () => {
    void Promise.resolve(cleanup()).catch(() => {})
  }

  if (signal.aborted) {
    onAbort()
    return () => {}
  }

  signal.addEventListener("abort", onAbort, { once: true })
  return () => signal.removeEventListener("abort", onAbort)
}

function buildRequestInit(input: {
  signal?: AbortSignal
  headers?: Record<string, string>
}): RequestInit | undefined {
  const requestInit: RequestInit = {}
  if (input.signal) requestInit.signal = input.signal
  if (input.headers && Object.keys(input.headers).length > 0) {
    requestInit.headers = input.headers
  }
  return requestInit.signal || requestInit.headers ? requestInit : undefined
}

async function connectClient(
  client: Client,
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport,
  options: {
    signal?: AbortSignal
    cleanup?: () => Promise<void> | void
  } = {}
): Promise<void> {
  const releaseAbort = bindAbortCleanup(options.signal, async () => {
    await options.cleanup?.()
    await transport.close().catch(() => {})
    await client.close().catch(() => {})
  })

  try {
    await client.connect(transport, options.signal ? { signal: options.signal } : undefined)
    throwIfAborted(options.signal)
  } catch (error) {
    throwIfAborted(options.signal)
    throw error
  } finally {
    releaseAbort()
  }
}

/**
 * Connect to an MCP server. Handles stdio, remote (OAuth), and remote (token_command).
 */
export async function connectServer(
  name: string,
  config: ServerConfig & { type: "stdio" | "remote" },
  options: { signal?: AbortSignal } = {}
): Promise<McpConnection> {
  throwIfAborted(options.signal)
  const client = new Client({ name: "jig", version: "0.1.0" })

  if (config.type === "stdio") {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      stderr: "ignore",
    })
    await connectClient(client, transport, { signal: options.signal })
    return { client, transport, serverName: name, config }
  }

  // Remote server with token_command or custom headers
  if (config.auth || config.headers) {
    return connectWithHeaders(name, config, options)
  }

  // Remote server with browser OAuth
  return connectWithOAuth(name, config, options)
}

/**
 * Connect using a token from a shell command and/or custom headers.
 */
async function connectWithHeaders(
  name: string,
  config: ServerConfig & { type: "remote" },
  options: { signal?: AbortSignal } = {}
): Promise<McpConnection> {
  throwIfAborted(options.signal)
  const headers: Record<string, string> = {}
  if (config.auth) {
    const token = await resolveToken(config.auth)
    headers["Authorization"] = `Bearer ${token}`
  }
  if (config.headers) {
    Object.assign(headers, config.headers)
  }
  const url = new URL(config.url)
  const client = new Client({ name: "jig", version: "0.1.0" })

  try {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: buildRequestInit({ headers, signal: options.signal }),
    })
    await connectClient(client, transport, { signal: options.signal })
    return { client, transport, serverName: name, config }
  } catch {
    // Fall back to SSE
    throwIfAborted(options.signal)
    const sseClient = new Client({ name: "jig", version: "0.1.0" })
    const transport = new SSEClientTransport(url, {
      requestInit: buildRequestInit({ headers, signal: options.signal }),
    })
    await connectClient(sseClient, transport, { signal: options.signal })
    return { client: sseClient, transport, serverName: name, config }
  }
}

/**
 * Connect using browser OAuth (for servers that support dynamic client registration).
 */
async function connectWithOAuth(
  name: string,
  config: ServerConfig & { type: "remote" },
  options: { signal?: AbortSignal } = {}
): Promise<McpConnection> {
  throwIfAborted(options.signal)
  const authProvider = new JigOAuthProvider(name)
  const url = new URL(config.url)
  const client = new Client({ name: "jig", version: "0.1.0" })
  const transport = new StreamableHTTPClientTransport(url, {
    authProvider,
    requestInit: buildRequestInit({ signal: options.signal }),
  })

  try {
    await connectClient(client, transport, {
      signal: options.signal,
      cleanup: () => authProvider.stopCallbackServer(),
    })
    return { client, transport, serverName: name, config }
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return finishOAuthAuthorization(name, config, authProvider, transport, options)
    }
    // StreamableHTTP failed for non-auth reason — try SSE
    try {
      throwIfAborted(options.signal)
      const sseClient = new Client({ name: "jig", version: "0.1.0" })
      const transport = new SSEClientTransport(url, {
        authProvider,
        requestInit: buildRequestInit({ signal: options.signal }),
      })
      await connectClient(sseClient, transport, {
        signal: options.signal,
        cleanup: () => authProvider.stopCallbackServer(),
      })
      return { client: sseClient, transport, serverName: name, config }
    } catch (sseError) {
      if (sseError instanceof UnauthorizedError) {
        return handleOAuthRedirect(name, config, authProvider, options)
      }
      throw sseError
    }
  }
}

async function finishOAuthAuthorization(
  name: string,
  config: ServerConfig & { type: "remote" },
  authProvider: JigOAuthProvider,
  transport: StreamableHTTPClientTransport,
  options: { signal?: AbortSignal } = {}
): Promise<McpConnection> {
  throwIfAborted(options.signal)
  console.log(`[jig] ${name} requires authorization — opening browser...`)

  const dots = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  let dotIdx = 0
  const spinner = setInterval(() => {
    process.stdout.write(`\r${dots[dotIdx++ % dots.length]} Waiting for browser authorization...`)
  }, 100)

  try {
    const authCode = await authProvider.waitForAuthCode(options.signal)
    clearInterval(spinner)
    process.stdout.write("\r\x1b[K")
    throwIfAborted(options.signal)
    await transport.finishAuth(authCode)

    const freshClient = new Client({ name: "jig", version: "0.1.0" })
    const freshTransport = new StreamableHTTPClientTransport(new URL(config.url), {
      authProvider,
      requestInit: buildRequestInit({ signal: options.signal }),
    })
    await connectClient(freshClient, freshTransport, {
      signal: options.signal,
      cleanup: () => authProvider.stopCallbackServer(),
    })
    authProvider.stopCallbackServer()
    return { client: freshClient, transport: freshTransport, serverName: name, config }
  } catch (error) {
    clearInterval(spinner)
    process.stdout.write("\r\x1b[K")
    authProvider.stopCallbackServer()
    throw error
  }
}

async function handleOAuthRedirect(
  name: string,
  config: ServerConfig & { type: "remote" },
  authProvider: JigOAuthProvider,
  options: { signal?: AbortSignal } = {}
): Promise<McpConnection> {
  throwIfAborted(options.signal)
  console.log(`[jig] ${name} requires authorization — opening browser...`)

  const dots = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
  let dotIdx = 0
  const spinner = setInterval(() => {
    process.stdout.write(`\r${dots[dotIdx++ % dots.length]} Waiting for browser authorization...`)
  }, 100)

  const client = new Client({ name: "jig", version: "0.1.0" })
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    authProvider,
    requestInit: buildRequestInit({ signal: options.signal }),
  })

  try {
    await connectClient(client, transport, {
      signal: options.signal,
      cleanup: () => authProvider.stopCallbackServer(),
    })
    return { client, transport, serverName: name, config }
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      const authCode = await authProvider.waitForAuthCode(options.signal)
      throwIfAborted(options.signal)
      await transport.finishAuth(authCode)

      const freshClient = new Client({ name: "jig", version: "0.1.0" })
      const freshTransport = new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider,
        requestInit: buildRequestInit({ signal: options.signal }),
      })
      await connectClient(freshClient, freshTransport, {
        signal: options.signal,
        cleanup: () => authProvider.stopCallbackServer(),
      })
      authProvider.stopCallbackServer()
      return { client: freshClient, transport: freshTransport, serverName: name, config }
    }
    authProvider.stopCallbackServer()
    throw error
  } finally {
    clearInterval(spinner)
    process.stdout.write("\r\x1b[K")
  }
}

/**
 * Discover all tools from a connected MCP server. Caches schemas to .jig/schemas/.
 */
export async function discoverTools(connection: McpConnection, options: { signal?: AbortSignal } = {}): Promise<Tool[]> {
  throwIfAborted(options.signal)
  const allTools: Tool[] = []
  let cursor: string | undefined

  do {
    throwIfAborted(options.signal)
    const result = await connection.client.listTools(
      { cursor },
      options.signal ? { signal: options.signal } : undefined
    )
    allTools.push(...result.tools)
    cursor = result.nextCursor
  } while (cursor)

  throwIfAborted(options.signal)
  await mkdir(SCHEMAS_DIR, { recursive: true })
  await Bun.write(
    join(SCHEMAS_DIR, `${connection.serverName}.json`),
    JSON.stringify(allTools, null, 2)
  )
  cacheToolSchemas(connection.serverName, allTools)

  return allTools
}

export interface NotificationHint {
  label: string          // "Telegram", "Gmail"
  textField: string      // inputSchema property holding the message body
  recipientField: string // inputSchema property holding the recipient/destination
  extraRequired: string[] // other required fields the user must configure
}

/**
 * Ensures every tool has readOnlyHint, destructiveHint, and (optionally)
 * notificationHint annotations. Uses LLM to infer missing ones and verify
 * existing ones. Called once during `jig connect`, not on subsequent runtime
 * connections.
 */
export async function ensureAnnotations(tools: Tool[], options: { signal?: AbortSignal } = {}): Promise<void> {
  const { llm } = await import("../sdk/llm.js")
  throwIfAborted(options.signal)

  const toolList = tools.map(t => {
    const ann = (t as any).annotations
    const existing = ann?.readOnlyHint !== undefined ? ` [readOnlyHint=${ann.readOnlyHint}]` : ""
    return `${t.name}:${existing} ${t.description ?? ""}`
  }).join("\n")

  // Compact inputSchema listing so the LLM can pick textField / recipientField
  // from real property names when classifying notification tools.
  const schemaHints = tools.map(t => {
    const props = (t.inputSchema as any)?.properties ?? {}
    const required: string[] = (t.inputSchema as any)?.required ?? []
    const keys = Object.keys(props)
    if (keys.length === 0) return null
    return `${t.name}: props=[${keys.join(",")}] required=[${required.join(",")}]`
  }).filter(Boolean).join("\n")

  const result = await llm<{
    readOnly: string[]
    destructive: string[]
    notification: Array<{ name: string; label: string; textField: string; recipientField: string; extraRequired?: string[] }>
  }>(
    `For each tool, determine:
1. "readOnly": tools that ONLY retrieve/view data (no side effects)
2. "destructive": tools that delete, overwrite, or permanently alter data
3. "notification": tools that can SEND a short text alert to a human.
   Examples: telegram_send_message, gmail_send_email, slack_post_message, twilio_send_sms.
   NOT drafts, edits, uploads, or file sends.
   For each qualifying tool, return an object:
     - "name": the tool name
     - "label": human-friendly channel name (capitalize, drop underscores, e.g. "Telegram", "Gmail")
     - "textField": inputSchema property holding the message body (must exist in props list)
     - "recipientField": inputSchema property holding the recipient/destination (must exist in props list)
     - "extraRequired": other required inputSchema fields the user must configure (e.g. ["subject"] for email)

Some tools already have [readOnlyHint=true/false] — verify those are correct and include/exclude them accordingly.
Everything not in "readOnly" or "destructive" is a normal mutate tool (create, send, update).

Tools:
${toolList}

Input schemas (for notification field selection):
${schemaHints}`,
    {},
    { schema: { readOnly: "array", destructive: "array", notification: "array" } as any, signal: options.signal }
  )
  throwIfAborted(options.signal)

  const readOnlySet = new Set(result.readOnly ?? [])
  const destructiveSet = new Set(result.destructive ?? [])
  const notificationMap = new Map<string, NotificationHint>()
  for (const n of result.notification ?? []) {
    if (!n?.name || !n?.textField || !n?.recipientField) continue
    notificationMap.set(n.name, {
      label: n.label ?? n.name,
      textField: n.textField,
      recipientField: n.recipientField,
      extraRequired: Array.isArray(n.extraRequired) ? n.extraRequired : [],
    })
  }

  for (const t of tools) {
    if (!(t as any).annotations) (t as any).annotations = {}
    ;(t as any).annotations.readOnlyHint = readOnlySet.has(t.name)
    ;(t as any).annotations.destructiveHint = destructiveSet.has(t.name)
    const hint = notificationMap.get(t.name)
    if (hint) (t as any).annotations.notificationHint = hint
    else delete (t as any).annotations.notificationHint
  }
}

/**
 * Call a tool on a connected MCP server.
 */
/** Registry of all open connections for cleanup. */
const openConnections = new Map<string, McpConnection>()

export function registerConnection(name: string, conn: McpConnection) {
  openConnections.set(name, conn)
}

/** Close all open MCP connections. Call at end of CLI runs and server shutdown. */
export async function closeAllConnections(): Promise<void> {
  const closes = [...openConnections.values()].map(async (conn) => {
    try { await conn.transport.close() } catch {}
    try { await conn.client.close() } catch {}
  })
  await Promise.allSettled(closes)
  openConnections.clear()
}

export async function callTool(
  connection: McpConnection,
  toolName: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  await validateRequiredToolArguments(connection, toolName, params)

  const signal = options?.signal ?? runContext.getStore()?.signal
  const result = await connection.client.callTool({
    name: toolName,
    arguments: params,
  }, undefined, signal ? { signal } : undefined)
  const normalized = normalizeToolResult(result)
  const toolError = extractToolError(normalized)
  if (result.isError || toolError) {
    throw new Error(toolError ?? `Tool "${connection.serverName}.${toolName}" returned an error`)
  }
  return normalized
}

export function shouldReconnectMcpConnection(error: unknown): boolean {
  const haystack = collectErrorStrings(error).join("\n").toLowerCase()
  if (!haystack) return false

  const hasMissingSession =
    haystack.includes("session id")
    && haystack.includes("not found")

  const hasClosedTransport =
    haystack.includes("connection closed")
    || haystack.includes("transport closed")
    || haystack.includes("other side closed")
    || haystack.includes("socket hang up")
    || haystack.includes("econnreset")

  return hasMissingSession || hasClosedTransport
}

function parseToolText(text: string): unknown {
  const trimmed = text.trim()
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  const candidate = fenced?.[1]?.trim() ?? trimmed

  try {
    return JSON.parse(candidate)
  } catch {
    return text
  }
}

function normalizeToolResult(result: {
  [key: string]: unknown
  structuredContent?: unknown
  content?: unknown
}): unknown {
  if (result.structuredContent != null) {
    return result.structuredContent
  }

  if (result.content && Array.isArray(result.content)) {
    const textParts = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)

    if (textParts.length === 1) {
      return parseToolText(textParts[0])
    }
    if (textParts.length > 1) return textParts
  }

  return result.content
}

async function validateRequiredToolArguments(
  connection: McpConnection,
  toolName: string,
  params: Record<string, unknown>
): Promise<void> {
  const tool = await getToolSchema(connection, toolName)
  const schema = tool?.inputSchema as Record<string, unknown> | undefined
  const required = Array.isArray(schema?.required)
    ? schema.required.filter((value): value is string => typeof value === "string")
    : []

  if (required.length === 0) return

  const properties = isRecord(schema?.properties) ? schema.properties : {}
  const missing = required.filter((name) => isMissingRequiredValue(params[name], properties[name]))
  if (missing.length === 0) return

  throw new Error(
    `Missing required parameter${missing.length === 1 ? "" : "s"} for ${connection.serverName}.${toolName}: ${missing.join(", ")}`
  )
}

async function getToolSchema(connection: McpConnection, toolName: string): Promise<Tool | null> {
  const cached = toolSchemaCache.get(connection.serverName)
  if (cached) return cached.get(toolName) ?? null

  const fromDisk = loadToolSchemasFromDisk(connection.serverName)
  if (fromDisk) return fromDisk.get(toolName) ?? null

  const client = connection.client as unknown as {
    listTools?: (args?: { cursor?: string }) => Promise<{ tools?: Tool[]; nextCursor?: string }>
  }
  if (typeof client.listTools !== "function") return null

  try {
    const tools: Tool[] = []
    let cursor: string | undefined
    do {
      const result = await client.listTools({ cursor })
      tools.push(...(result.tools ?? []))
      cursor = result.nextCursor
    } while (cursor)
    cacheToolSchemas(connection.serverName, tools)
  } catch {
    return null
  }

  return toolSchemaCache.get(connection.serverName)?.get(toolName) ?? null
}

function loadToolSchemasFromDisk(serverName: string): Map<string, Tool> | null {
  const schemaPath = join(SCHEMAS_DIR, `${serverName}.json`)
  if (!existsSync(schemaPath)) return null

  try {
    const tools = JSON.parse(readFileSync(schemaPath, "utf8")) as Tool[]
    return cacheToolSchemas(serverName, tools)
  } catch {
    return null
  }
}

function cacheToolSchemas(serverName: string, tools: Tool[]): Map<string, Tool> {
  const index = new Map<string, Tool>(tools.map((tool) => [tool.name, tool]))
  toolSchemaCache.set(serverName, index)
  return index
}

function isMissingRequiredValue(value: unknown, schema: unknown): boolean {
  if (value == null) return true
  if (typeof value === "string" && schemaAllowsString(schema)) return value.trim().length === 0
  return false
}

function schemaAllowsString(schema: unknown): boolean {
  if (!isRecord(schema)) return false
  if (schema.type === "string") return true
  if (Array.isArray(schema.type) && schema.type.includes("string")) return true
  if (Array.isArray(schema.anyOf) && schema.anyOf.some(schemaAllowsString)) return true
  if (Array.isArray(schema.oneOf) && schema.oneOf.some(schemaAllowsString)) return true
  return false
}

function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function extractToolError(result: unknown): string | null {
  if (typeof result === "string") return result.trim() || null
  if (Array.isArray(result)) {
    const parts = result.filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    return parts.length > 0 ? parts.join("\n") : null
  }
  if (!isRecord(result)) return null
  if (typeof result.error === "string" && result.error.trim()) return result.error.trim()
  return null
}

function collectErrorStrings(value: unknown, seen = new Set<unknown>()): string[] {
  if (value == null) return []
  if (typeof value === "string") return [value]
  if (typeof value === "number" || typeof value === "boolean") return [String(value)]
  if (seen.has(value)) return []
  if (typeof value !== "object") return []

  seen.add(value)
  const out: string[] = []
  if (value instanceof Error) {
    out.push(value.name, value.message)
    if ("cause" in value && value.cause) out.push(...collectErrorStrings(value.cause, seen))
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (typeof nested === "string") out.push(nested)
    else if (typeof nested === "number" || typeof nested === "boolean") out.push(String(nested))
    else if (nested && typeof nested === "object") out.push(...collectErrorStrings(nested, seen))
    if (key === "name" && typeof nested === "string") out.push(nested)
  }
  return out
}

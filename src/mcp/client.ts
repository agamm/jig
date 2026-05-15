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
import { deleteCredentials } from "../db.js"
import { SCHEMAS_DIR } from "../config/paths.js"
import { runContext } from "../sdk/context.js"
import { USER_CANCELLED_MESSAGE } from "../run-cancel.js"
import { logSessionEvent } from "../debug/session-log.js"

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
    if (isAuthDeniedError(error)) {
      return recoverOAuth(name, config, authProvider, transport, error, options)
    }
    // StreamableHTTP failed for a non-auth reason — try SSE
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
      if (isAuthDeniedError(sseError)) {
        return recoverOAuth(name, config, authProvider, null, sseError, options)
      }
      throw sseError
    }
  }
}

/**
 * Auth denied on connect. Two sub-cases:
 *   1. No saved tokens yet (fresh install) → classic UnauthorizedError path;
 *      run the authorization dance against the original transport so the
 *      MCP SDK can pick up the code via `finishAuth`.
 *   2. Saved tokens exist but were rejected (rotated / expired / revoked) →
 *      nuke them and start a fresh OAuth round.
 *
 * We distinguish by checking the credentials table, not by inspecting the
 * error's shape. The `transport` arg is only forwarded in case (1); pass
 * `null` for paths where no transport was successfully constructed.
 */
async function recoverOAuth(
  name: string,
  config: ServerConfig & { type: "remote" },
  authProvider: JigOAuthProvider,
  transport: StreamableHTTPClientTransport | null,
  error: unknown,
  options: { signal?: AbortSignal },
): Promise<McpConnection> {
  const hasSavedTokens = (await authProvider.tokens()) !== undefined
  if (hasSavedTokens) {
    console.warn(`[jig] ${name}: saved OAuth credentials were rejected. Clearing and re-authorizing.`)
    deleteCredentials(name)
    return handleOAuthRedirect(name, config, new JigOAuthProvider(name), options)
  }
  // Fresh auth — reuse the existing transport when we have one so the SDK
  // can call finishAuth on the same instance.
  if (transport) return finishOAuthAuthorization(name, config, authProvider, transport, options)
  return handleOAuthRedirect(name, config, authProvider, options)
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

  let result: {
    readOnly: string[]
    destructive: string[]
    notification: Array<{ name: string; label: string; textField: string; recipientField: string; extraRequired?: string[] }>
  }
  try {
    result = await llm<typeof result>(
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
  } catch (error) {
    console.warn(`[typegen] annotation LLM failed; using deterministic hints: ${error instanceof Error ? error.message : String(error)}`)
    result = inferToolAnnotations(tools)
  }
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

function inferToolAnnotations(tools: Tool[]): {
  readOnly: string[]
  destructive: string[]
  notification: Array<{ name: string; label: string; textField: string; recipientField: string; extraRequired?: string[] }>
} {
  const readOnly: string[] = []
  const destructive: string[] = []
  const notification: Array<{ name: string; label: string; textField: string; recipientField: string; extraRequired?: string[] }> = []

  for (const tool of tools) {
    const name = tool.name.toLowerCase()
    if (/\b(delete|remove|trash|revoke|terminate)\b|_(delete|remove|trash|revoke|terminate)_?/.test(name)) {
      destructive.push(tool.name)
    } else if (/^(get|list|search|fetch|read|find)_|_(get|list|search|fetch|read|find)_/.test(name)) {
      readOnly.push(tool.name)
    }

    const props = ((tool.inputSchema as any)?.properties ?? {}) as Record<string, unknown>
    const required = Array.isArray((tool.inputSchema as any)?.required) ? (tool.inputSchema as any).required as string[] : []
    if (name.includes("send") || name.includes("message") || name.includes("email")) {
      const textField = firstExistingKey(props, ["text", "message", "body", "content"])
      const recipientField = firstExistingKey(props, ["chat_id", "recipient_email", "to", "channel", "recipient", "user_id"])
      if (textField && recipientField) {
        notification.push({
          name: tool.name,
          label: tool.name.split("_")[0]?.replace(/^\w/, (c) => c.toUpperCase()) || tool.name,
          textField,
          recipientField,
          extraRequired: required.filter((key) => key !== textField && key !== recipientField),
        })
      }
    }
  }

  return { readOnly, destructive, notification }
}

function firstExistingKey(props: Record<string, unknown>, keys: string[]): string | null {
  return keys.find((key) => key in props) ?? null
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

/** Close a single open MCP connection by server name, if any. */
export async function closeConnection(name: string): Promise<void> {
  const conn = openConnections.get(name)
  if (!conn) return
  openConnections.delete(name)
  try { await conn.transport.close() } catch {}
  try { await conn.client.close() } catch {}
}

/**
 * Get the open connection for a server, opening one if needed. Used by
 * server-side callers (e.g. introspection) that want the same lazy-connect
 * semantics generated bindings use.
 */
export async function acquireConnection(
  name: string,
  config: ServerConfig & { type: "stdio" | "remote" },
): Promise<McpConnection> {
  const existing = openConnections.get(name)
  if (existing) return existing
  const conn = await connectServer(name, config)
  registerConnection(name, conn)
  return conn
}

export async function callTool(
  connection: McpConnection,
  toolName: string,
  params: Record<string, unknown>,
  options?: { signal?: AbortSignal }
): Promise<unknown> {
  const normalizedParams = normalizeOutgoingToolParams(connection, toolName, params)
  await validateRequiredToolArguments(connection, toolName, normalizedParams)

  const signal = options?.signal ?? runContext.getStore()?.signal
  const startedAt = Date.now()
  logSessionEvent({
    source: "mcp.tool",
    event: "call",
    server: connection.serverName,
    tool: toolName,
    args: normalizedParams,
  })
  let result
  try {
    result = await connection.client.callTool({
      name: toolName,
      arguments: normalizedParams,
    }, undefined, signal ? { signal } : undefined)
  } catch (err) {
    logSessionEvent({
      source: "mcp.tool",
      event: "error",
      server: connection.serverName,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      error: err,
    })
    throw err
  }
  const normalized = normalizeToolResult(result)
  if (result.isError) {
    // MCP-standard error: isError flag is set. Use the normalized content as
    // the message if it's a plain string or has a canonical `{error: "..."}`
    // shape; otherwise fall back to a generic error.
    const msg = errorMessageFromResult(normalized) ??
      `Tool "${connection.serverName}.${toolName}" returned an error`
    logSessionEvent({
      source: "mcp.tool",
      event: "error",
      server: connection.serverName,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      error: msg,
      result: normalized,
    })
    throw new Error(msg)
  }
  const toolError = extractToolError(normalized)
  if (toolError) {
    logSessionEvent({
      source: "mcp.tool",
      event: "error",
      server: connection.serverName,
      tool: toolName,
      durationMs: Date.now() - startedAt,
      error: toolError,
      result: normalized,
    })
    throw new Error(toolError)
  }
  logSessionEvent({
    source: "mcp.tool",
    event: "result",
    server: connection.serverName,
    tool: toolName,
    durationMs: Date.now() - startedAt,
    result: normalized,
  })
  return normalized
}

function normalizeOutgoingToolParams(
  connection: McpConnection,
  toolName: string,
  params: Record<string, unknown>,
): Record<string, unknown> {
  if (toolName === "COMPOSIO_MULTI_EXECUTE_TOOL" && Array.isArray(params.tools)) {
    let changed = false
    const tools = params.tools.map((tool) => {
      if (!isRecord(tool)) return tool
      if (typeof tool.tool_slug !== "string" || !isGmailSendSlug(tool.tool_slug)) return tool
      const args = isRecord(tool.arguments) ? tool.arguments : {}
      changed = true
      return {
        ...tool,
        arguments: normalizeGmailSendArgs(args, true),
      }
    })
    if (changed) return { ...params, tools }
  }

  if (
    toolName === "COMPOSIO_MULTI_EXECUTE_TOOL" &&
    typeof params.tool_slug === "string" &&
    isGmailSendSlug(params.tool_slug)
  ) {
    const args = isRecord(params.arguments) ? params.arguments : {}
    return {
      ...params,
      arguments: normalizeGmailSendArgs(args, true),
    }
  }

  const combined = `${connection.serverName}.${toolName}`
  if (/gmail/i.test(combined) && /send/i.test(toolName)) {
    return normalizeGmailSendArgs(params, false)
  }

  return params
}

function isGmailSendSlug(slug: string): boolean {
  return /gmail.*send|send.*gmail/i.test(slug)
}

function normalizeGmailSendArgs(args: Record<string, unknown>, preferHtml: boolean): Record<string, unknown> {
  const bodyKey = ["body", "html", "message", "content"].find((key) => typeof args[key] === "string")
  if (!bodyKey) return args

  const rawBody = String(args[bodyKey])
  const explicitHtml = args.is_html === true || args.isHtml === true || bodyKey === "html"
  const looksHtml = /<[a-z][\s\S]*>/i.test(rawBody)
  const markdowny = /\*\*[^*\n]{1,120}\*\*|^\s{0,3}#{1,6}\s+/m.test(rawBody)
  if (!explicitHtml && !preferHtml && !markdowny) return args

  const body = looksHtml
    ? cleanupMarkdownInHtml(rawBody)
    : markdownishToHtml(rawBody)

  const next: Record<string, unknown> = { ...args, [bodyKey]: body }
  if ("is_html" in args || preferHtml) next.is_html = true
  if ("isHtml" in args) next.isHtml = true
  return next
}

function cleanupMarkdownInHtml(html: string): string {
  return html
    .replace(/(^|[\n>])\s{0,3}#{1,6}\s+/g, "$1")
    .replace(/\*\*([^*<>]{1,120})\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\n>])\s{0,3}>\s+/g, "$1")
}

function markdownishToHtml(markdown: string): string {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n")
  const chunks: string[] = []
  let listOpen = false

  const closeList = () => {
    if (!listOpen) return
    chunks.push("</ul>")
    listOpen = false
  }

  for (const rawLine of lines) {
    const line = rawLine.trim()
    if (!line) {
      closeList()
      continue
    }
    const heading = line.match(/^#{1,6}\s+(.+)$/)
    if (heading) {
      closeList()
      chunks.push(`<h2>${inlineMarkdownToHtml(heading[1])}</h2>`)
      continue
    }
    const bullet = line.match(/^[-*]\s+(.+)$/)
    if (bullet) {
      if (!listOpen) {
        chunks.push("<ul>")
        listOpen = true
      }
      chunks.push(`<li>${inlineMarkdownToHtml(bullet[1])}</li>`)
      continue
    }
    closeList()
    chunks.push(`<p>${inlineMarkdownToHtml(line)}</p>`)
  }
  closeList()

  return chunks.join("\n")
}

function inlineMarkdownToHtml(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]{1,120})\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]{1,120})\*/g, "<em>$1</em>")
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function errorMessageFromResult(result: unknown): string | null {
  if (typeof result === "string") {
    const t = result.trim()
    return t || null
  }
  if (isRecord(result) && typeof result.error === "string" && result.error.trim()) {
    return result.error.trim()
  }
  return null
}

export function shouldReconnectMcpConnection(error: unknown): boolean {
  // Auth-denied errors from a cached connection: the saved tokens expired
  // mid-run. Dropping the cached connection lets the typegen wrapper's
  // retry go through connectServer() again, where `connectWithOAuth` will
  // notice the auth failure on re-connect and trigger the stale-token
  // recovery path.
  if (isAuthDeniedError(error)) return true
  if (isDisconnectedMcpClientError(error)) return true

  // Transport-layer disconnects / missing sessions: classic reconnect case,
  // nothing to do with credentials.
  return isTransportReconnectable(error)
}

function isDisconnectedMcpClientError(error: unknown): boolean {
  return error instanceof Error && error.message === "Not connected"
}

/**
 * Detect auth-denied errors without pattern-matching message text.
 *
 * Sources of signal, in priority order:
 *   1. MCP SDK's `UnauthorizedError` class — canonical auth signal.
 *   2. HTTP status: `.status`, `.statusCode`, `.response.status`, or
 *      `.code` when it's a number (MCP's `StreamableHTTPError` stores the
 *      HTTP status in `.code`).
 *   3. OAuth2 error field (`.error`, or `.code` when it's a string) with
 *      one of the RFC 6749 error codes.
 *
 * The inspection walks `cause`, `response`, `data`, `body` so wrapped
 * errors surface the same signals as unwrapped ones. No regex, no
 * substring search — new providers work without updating a keyword list.
 */
export function isAuthDeniedError(error: unknown): boolean {
  if (error instanceof UnauthorizedError) return true
  for (const c of walkErrorShape(error)) {
    if (isAuthDeniedStatus(c.status ?? c.statusCode)) return true
    // `.code` is overloaded: MCP's StreamableHTTPError stores HTTP status
    // as a number there, while OAuth2 error bodies put a string code
    // (invalid_grant, invalid_token, …) in `.code` or `.error`.
    if (isAuthDeniedStatus(c.code)) return true
    if (isOAuthDenyCode(c.error ?? c.code)) return true
  }
  return false
}

function isAuthDeniedStatus(v: unknown): boolean {
  return v === 401 || v === 403
}

const OAUTH_DENY_CODES = new Set([
  "invalid_grant",
  "invalid_token",
  "invalid_client",
  "unauthorized_client",
  "access_denied",
])

function isOAuthDenyCode(v: unknown): boolean {
  return typeof v === "string" && OAUTH_DENY_CODES.has(v)
}

function isTransportReconnectable(error: unknown): boolean {
  for (const c of walkErrorShape(error)) {
    // Node / undici error codes are strings; the `.code` overload for HTTP
    // status (number) is already handled in the auth detector.
    if (typeof c.code === "string" && TRANSPORT_RECONNECT_CODES.has(c.code)) return true
    if (typeof c.name === "string" && TRANSPORT_RECONNECT_NAMES.has(c.name)) return true
    const message = c.message
    if (typeof message === "string" && TRANSPORT_RECONNECT_MESSAGES.some((pattern) => pattern.test(message))) return true
    // StreamableHTTPError doesn't set `.name`, so fall back to the class
    // name. Any SDK/Node error we want to reconnect on can be added here.
    const ctorName = (c.constructor as { name?: string } | undefined)?.name
    if (typeof ctorName === "string" && TRANSPORT_RECONNECT_NAMES.has(ctorName)) return true
  }
  return false
}

// Node / undici error codes that indicate the TCP/HTTP connection dropped.
const TRANSPORT_RECONNECT_CODES = new Set([
  "ECONNRESET",
  "ECONNABORTED",
  "EPIPE",
  "ETIMEDOUT",
  "ENOTFOUND",
  "UND_ERR_SOCKET",
  "UND_ERR_CLOSED",
])

// SDK error names/classes where the right response is to reconnect.
const TRANSPORT_RECONNECT_NAMES = new Set([
  "StreamableHTTPError",
  "SseError",
])

const TRANSPORT_RECONNECT_MESSAGES = [
  /\bSession ID\b[\s\S]*\bnot found\b/i,
  /\bConnection closed by peer\b/i,
  /\bconnection (?:closed|reset|aborted)\b/i,
  /\bsocket hang up\b/i,
]

/**
 * Yield the error and every wrapped object we might find a signal on.
 * Visits `.cause`, `.response`, `.data`, `.body`. Bounded by a `seen` set
 * so cyclic references don't infinite-loop.
 */
function* walkErrorShape(error: unknown): Generator<Record<string, unknown>, void, unknown> {
  const seen = new Set<unknown>()
  const stack: unknown[] = [error]
  while (stack.length) {
    const cur = stack.pop()
    if (!cur || typeof cur !== "object" || seen.has(cur)) continue
    seen.add(cur)
    const c = cur as Record<string, unknown>
    yield c
    const nested = [c.cause, c.response, c.data, c.body]
    for (const n of nested) if (n && typeof n === "object") stack.push(n)
  }
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
  // Errors are signalled by the MCP response's `isError` flag (checked by the
  // caller) or by an explicit `{ error: "..." }` field in structured content.
  // A plain string return value — e.g. Granola's list_meetings returning an
  // XML block — is NOT an error; treating it as one threw away every
  // text-typed tool response.
  if (!isRecord(result)) return null
  if (typeof result.error === "string" && result.error.trim()) return result.error.trim()
  return null
}

import { join } from "node:path"
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

export type McpConnection = {
  client: Client
  transport: StdioClientTransport | StreamableHTTPClientTransport | SSEClientTransport
  serverName: string
  config: ServerConfig
}

/**
 * Connect to an MCP server. Handles stdio, remote (OAuth), and remote (token_command).
 */
export async function connectServer(
  name: string,
  config: ServerConfig & { type: "stdio" | "remote" }
): Promise<McpConnection> {
  const client = new Client({ name: "jig", version: "0.1.0" })

  if (config.type === "stdio") {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      stderr: "ignore",
    })
    await client.connect(transport)
    return { client, transport, serverName: name, config }
  }

  // Remote server with token_command — use static auth header
  if (config.auth) {
    return connectWithToken(name, config as ServerConfig & { type: "remote"; auth: string })
  }

  // Remote server with browser OAuth
  return connectWithOAuth(name, config)
}

/**
 * Connect using a token from a shell command (e.g. "gh auth token").
 */
async function connectWithToken(
  name: string,
  config: ServerConfig & { type: "remote"; auth: string }
): Promise<McpConnection> {
  const token = await resolveToken(config.auth)
  const url = new URL(config.url)

  const headers = { Authorization: `Bearer ${token}` }
  const client = new Client({ name: "jig", version: "0.1.0" })

  try {
    const transport = new StreamableHTTPClientTransport(url, {
      requestInit: { headers },
    })
    await client.connect(transport)
    return { client, transport, serverName: name, config }
  } catch {
    // Fall back to SSE
    const sseClient = new Client({ name: "jig", version: "0.1.0" })
    const transport = new SSEClientTransport(url, {
      requestInit: { headers },
    })
    await sseClient.connect(transport)
    return { client: sseClient, transport, serverName: name, config }
  }
}

/**
 * Connect using browser OAuth (for servers that support dynamic client registration).
 */
async function connectWithOAuth(
  name: string,
  config: ServerConfig & { type: "remote" }
): Promise<McpConnection> {
  const authProvider = new JigOAuthProvider(name)
  const url = new URL(config.url)
  const client = new Client({ name: "jig", version: "0.1.0" })

  try {
    const transport = new StreamableHTTPClientTransport(url, { authProvider })
    await client.connect(transport)
    return { client, transport, serverName: name, config }
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      return handleOAuthRedirect(name, config, authProvider)
    }
    // StreamableHTTP failed for non-auth reason — try SSE
    try {
      const sseClient = new Client({ name: "jig", version: "0.1.0" })
      const transport = new SSEClientTransport(url, { authProvider })
      await sseClient.connect(transport)
      return { client: sseClient, transport, serverName: name, config }
    } catch (sseError) {
      if (sseError instanceof UnauthorizedError) {
        return handleOAuthRedirect(name, config, authProvider)
      }
      throw sseError
    }
  }
}

async function handleOAuthRedirect(
  name: string,
  config: ServerConfig & { type: "remote" },
  authProvider: JigOAuthProvider
): Promise<McpConnection> {
  console.log(`[jig] ${name} requires authorization — opening browser...`)

  const codePromise = authProvider.waitForAuthCode()
  const client = new Client({ name: "jig", version: "0.1.0" })
  const transport = new StreamableHTTPClientTransport(new URL(config.url), {
    authProvider,
  })

  try {
    await client.connect(transport)
    return { client, transport, serverName: name, config }
  } catch (error) {
    if (error instanceof UnauthorizedError) {
      const authCode = await codePromise
      await transport.finishAuth(authCode)

      const freshClient = new Client({ name: "jig", version: "0.1.0" })
      const freshTransport = new StreamableHTTPClientTransport(new URL(config.url), {
        authProvider,
      })
      await freshClient.connect(freshTransport)
      authProvider.stopCallbackServer()
      return { client: freshClient, transport: freshTransport, serverName: name, config }
    }
    throw error
  }
}

/**
 * Discover all tools from a connected MCP server. Caches schemas to .jig/schemas/.
 */
export async function discoverTools(connection: McpConnection): Promise<Tool[]> {
  const allTools: Tool[] = []
  let cursor: string | undefined

  do {
    const result = await connection.client.listTools({ cursor })
    allTools.push(...result.tools)
    cursor = result.nextCursor
  } while (cursor)

  await mkdir(SCHEMAS_DIR, { recursive: true })
  await Bun.write(
    join(SCHEMAS_DIR, `${connection.serverName}.json`),
    JSON.stringify(allTools, null, 2)
  )

  return allTools
}

/**
 * Ensures every tool has readOnlyHint and destructiveHint annotations.
 * Uses LLM to infer missing ones and verify existing ones.
 * Called once during `jig connect`, not on subsequent runtime connections.
 */
export async function ensureAnnotations(tools: Tool[]): Promise<void> {
  const { llm } = await import("../sdk/llm.js")

  const toolList = tools.map(t => {
    const ann = (t as any).annotations
    const existing = ann?.readOnlyHint !== undefined ? ` [readOnlyHint=${ann.readOnlyHint}]` : ""
    return `${t.name}:${existing} ${t.description ?? ""}`
  }).join("\n")

  const result = await llm<{ readOnly: string[]; destructive: string[] }>(
    `For each tool, determine:
1. "readOnly": tools that ONLY retrieve/view data (no side effects)
2. "destructive": tools that delete, overwrite, or permanently alter data

Some tools already have [readOnlyHint=true/false] — verify those are correct and include/exclude them accordingly.
Everything not in "readOnly" or "destructive" is a normal mutate tool (create, send, update).

Tools:
${toolList}`,
    {},
    { schema: { readOnly: "array", destructive: "array" } as any }
  )

  const readOnlySet = new Set(result.readOnly ?? [])
  const destructiveSet = new Set(result.destructive ?? [])

  for (const t of tools) {
    if (!(t as any).annotations) (t as any).annotations = {}
    ;(t as any).annotations.readOnlyHint = readOnlySet.has(t.name)
    ;(t as any).annotations.destructiveHint = destructiveSet.has(t.name)
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
  params: Record<string, unknown>
): Promise<unknown> {
  const result = await connection.client.callTool({
    name: toolName,
    arguments: params,
  })

  if (result.content && Array.isArray(result.content)) {
    const textParts = result.content
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)

    if (textParts.length === 1) {
      try {
        return JSON.parse(textParts[0])
      } catch {
        return textParts[0]
      }
    }
    if (textParts.length > 1) return textParts
  }

  return result.structuredContent ?? result.content
}

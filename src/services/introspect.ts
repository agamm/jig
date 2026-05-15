/**
 * Tool output introspection — invokes a chosen MCP tool against the live
 * connection, walks the result, and returns a compact structural report.
 *
 * Designed for the authoring agent: once it has decided which tool to call,
 * it can introspect the real output shape and write correct unwrap code on
 * the first try — instead of guessing `result.items || result.messages || []`
 * and silently collapsing to an empty array.
 *
 * The full data is never returned. We return:
 *   - shape: a depth-limited structural descriptor
 *   - preview: first ~1KB of the JSON-stringified (and redacted) result
 *   - durationMs: how long the call took
 *
 * Safety: refuses non-read-only tools (`annotations.readOnlyHint !== true`)
 * unless the caller explicitly opts in via `allowWrite: true`. This stops
 * the agent from sending test emails / writing files while probing.
 */
import { join } from "node:path"
import { acquireConnection, callTool } from "../mcp/client.js"
import { getServerConfig } from "../mcp/config.js"
import { SCHEMAS_DIR } from "../config/paths.js"
import { redact } from "../debug/redact.js"

export type Shape =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "boolean"; sample: boolean }
  | { type: "number"; sample: number }
  | { type: "bigint"; sample: string }
  | { type: "string"; length: number; sample: string }
  | { type: "array"; length: number; item?: Shape }
  | { type: "object"; keys: Record<string, Shape>; truncatedKeys?: number }
  | { type: "function" }
  | { type: "circular" }
  | { type: "max-depth"; preview: string }

const MAX_DEPTH = 6
const MAX_OBJECT_KEYS = 40
const STRING_SAMPLE_LEN = 80
const PREVIEW_BYTES = 1024

export function describeShape(value: unknown, depth = 0, seen = new WeakSet<object>()): Shape {
  if (value === null) return { type: "null" }
  if (value === undefined) return { type: "undefined" }
  if (typeof value === "boolean") return { type: "boolean", sample: value }
  if (typeof value === "number") return { type: "number", sample: value }
  if (typeof value === "bigint") return { type: "bigint", sample: value.toString() }
  if (typeof value === "function") return { type: "function" }
  if (typeof value === "string") {
    return {
      type: "string",
      length: value.length,
      sample: value.length > STRING_SAMPLE_LEN ? value.slice(0, STRING_SAMPLE_LEN - 1) + "…" : value,
    }
  }
  if (depth >= MAX_DEPTH) {
    let preview = ""
    try { preview = JSON.stringify(value).slice(0, 80) } catch { preview = "<unserializable>" }
    return { type: "max-depth", preview }
  }
  if (seen.has(value as object)) return { type: "circular" }
  seen.add(value as object)

  if (Array.isArray(value)) {
    return {
      type: "array",
      length: value.length,
      ...(value.length > 0 ? { item: describeShape(value[0], depth + 1, seen) } : {}),
    }
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const truncatedKeys = entries.length > MAX_OBJECT_KEYS ? entries.length - MAX_OBJECT_KEYS : 0
  const sliced = entries.slice(0, MAX_OBJECT_KEYS)
  const keys: Record<string, Shape> = {}
  for (const [k, v] of sliced) keys[k] = describeShape(v, depth + 1, seen)
  return truncatedKeys > 0 ? { type: "object", keys, truncatedKeys } : { type: "object", keys }
}

export interface IntrospectResult {
  ok: true
  server: string
  tool: string
  shape: Shape
  preview: string
  durationMs: number
  readOnly: boolean
}

export interface IntrospectRefusal {
  ok: false
  error: string
  reason?: "not_read_only" | "no_schema" | "unknown_server"
  hint?: string
}

interface SchemaEntry {
  name: string
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean }
}

async function loadAnnotations(server: string, tool: string): Promise<SchemaEntry | null> {
  try {
    const path = join(SCHEMAS_DIR, `${server}.json`)
    const arr = (await Bun.file(path).json()) as SchemaEntry[]
    return arr.find((t) => t.name === tool) ?? null
  } catch {
    return null
  }
}

export async function introspectToolOutput(args: {
  server: string
  tool: string
  args?: Record<string, unknown>
  allowWrite?: boolean
}): Promise<IntrospectResult | IntrospectRefusal> {
  const schemaEntry = await loadAnnotations(args.server, args.tool)
  if (!schemaEntry) {
    return {
      ok: false,
      error: `No cached schema for ${args.server}.${args.tool} — connect the server or check the tool name`,
      reason: "no_schema",
      hint: `Run get_tool_schema first to list available tools.`,
    }
  }
  const readOnly = schemaEntry.annotations?.readOnlyHint === true
  if (!readOnly && !args.allowWrite) {
    return {
      ok: false,
      error: `Refusing to introspect "${args.tool}" — annotations say it's not read-only and could have side effects (sending email, mutating data, etc.). Pass allowWrite:true only if probing this call with the supplied args is safe.`,
      reason: "not_read_only",
    }
  }

  let config
  try {
    config = await getServerConfig(args.server)
  } catch (err: any) {
    return {
      ok: false,
      error: `Unknown server "${args.server}": ${err?.message ?? err}`,
      reason: "unknown_server",
    }
  }

  const startedAt = Date.now()
  const connection = await acquireConnection(args.server, config)
  // For proxy servers (composio, etc.), the cached schema names like
  // `gmail_fetch_emails` aren't real MCP tools — they're proxied via
  // `COMPOSIO_MULTI_EXECUTE_TOOL`. Detect via config.proxy and wrap the call
  // the same way the generated binding does, then unwrap the envelope so the
  // shape descriptor reflects what the jig actually sees inside its handler.
  // callTool emits [mcp.tool] events, so probes show up in the dashboard logs.
  let result: unknown
  const proxyVia = (config as any)?.proxy?.via
  if (typeof proxyVia === "string" && proxyVia.length > 0) {
    const slug = args.tool.toUpperCase()
    const raw: any = await callTool(connection, proxyVia, {
      tools: [{ tool_slug: slug, arguments: args.args ?? {} }],
      sync_response_to_workbench: false,
    })
    const execResult = raw?.data?.results?.[0] ?? {}
    result = execResult?.response?.data ?? execResult?.response?.data_preview ?? execResult?.response ?? raw
  } else {
    result = await callTool(connection, args.tool, (args.args ?? {}) as Record<string, unknown>)
  }
  const durationMs = Date.now() - startedAt

  const redacted = redact(result)
  const shape = describeShape(redacted)
  let preview: string
  try { preview = JSON.stringify(redacted).slice(0, PREVIEW_BYTES) } catch { preview = "<unserializable>" }
  if (preview.length === PREVIEW_BYTES) preview += "…"

  return {
    ok: true,
    server: args.server,
    tool: args.tool,
    shape,
    preview,
    durationMs,
    readOnly,
  }
}

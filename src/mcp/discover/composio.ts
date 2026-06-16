/**
 * Composio tool discovery — finds real tools behind meta-tool orchestration.
 *
 * Composio's MCP server exposes a handful of meta-tools instead of individual
 * service tools. This script runs during `jig connect composio` to discover the
 * actual tools (gmail_send_email, slack_send_message, etc.) and generate typed
 * wrappers.
 *
 * ## How discovery works
 *
 * 1. Identify connected toolkits. We sweep a broad battery of use-case queries
 *    through COMPOSIO_SEARCH_TOOLS; its `toolkit_connection_statuses[]` reports
 *    an accurate `has_active_connection` per surfaced toolkit. We keep the ones
 *    that are connected.
 * 2. For each connected toolkit, call COMPOSIO_SEARCH_TOOLS again ("<toolkit>
 *    actions") to enumerate its tool slugs + inline schemas.
 * 3. Fetch full schemas for tools that weren't returned inline
 *    (COMPOSIO_GET_TOOL_SCHEMAS).
 *
 * ## Why a use-case sweep instead of an endpoint?
 *
 * Discovery used to read the session root endpoint
 * (`GET /api/v3/tool_router/session/{id}` with the sandbox `x-session-access-key`)
 * for `config.auth_configs`. Composio locked that down — it now returns
 * `401 "Session access key is not accepted on this endpoint"`, and every other
 * enumeration a pure MCP client can reach is gone too:
 * - the workbench session key is rejected on all standard `/api/v3/*` endpoints
 * - the python SDK needs a `COMPOSIO_API_KEY` the sandbox doesn't expose
 * - jig's OAuth token is MCP-scoped and rejected as an API key
 * - `COMPOSIO_MANAGE_CONNECTIONS` can report status but requires named toolkit
 *   candidates (an empty list is rejected)
 *
 * COMPOSIO_SEARCH_TOOLS is the one meta-tool that returns accurate connection
 * status, but only for toolkits a query touches — so we sweep PROBE_QUERIES
 * across common categories. A connected toolkit outside every category won't be
 * found; add a matching use-case to PROBE_QUERIES and re-run `jig connect
 * composio` if a niche service is missed.
 *
 * Composio feature request filed (ComposioHQ/composio#3118) to add a proper
 * COMPOSIO_LIST_CONNECTED_TOOLKITS meta-tool.
 *
 * To refresh tools after connecting new services: `jig connect composio`
 *
 * Created: 2026-04-05
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import type { McpConnection } from "../client.js"
import { callTool } from "../client.js"
import { firstLineSummary } from "../../text.js"

/**
 * Broad, category-spanning use cases. SEARCH_TOOLS only reports a toolkit's
 * connection status when a query touches its domain, so this battery is how we
 * surface whatever the user has connected. These are use cases, not toolkit
 * slugs — any toolkit serving one of these domains will be found.
 */
const PROBE_QUERIES = [
  "send and read email",
  "manage calendar events and scheduling",
  "send messages in a team chat workspace",
  "create and edit documents, notes, and wikis",
  "manage git repositories, issues, and pull requests",
  "read and write spreadsheets",
  "manage CRM contacts, leads, and deals",
  "track project tasks and tickets",
  "store, sync, and share files in cloud storage",
  "post to and read from social media",
  "process payments, invoices, and subscriptions",
  "manage customer support tickets and conversations",
  "send SMS and make phone calls",
  "manage cloud infrastructure and servers",
  "run marketing email campaigns and newsletters",
  "schedule meetings and video calls",
  "manage an e-commerce store, products, and orders",
  "collect form responses and survey results",
  "query product analytics and dashboards",
  "manage databases and structured records",
  "manage a knowledge base and help-center articles",
  "manage HR, recruiting, and applicant tracking",
  "manage accounting and bookkeeping",
  "transcribe meetings and take notes",
]

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * Whether a composio tool slug (e.g. "GMAIL_SEND_EMAIL") belongs to one of the
 * connected toolkits. Slugs prefix the toolkit name and an underscore; some
 * toolkits drop their own separators in slugs ("digital_ocean" → "DIGITALOCEAN_").
 * The trailing "_" keeps "slack" from matching "slackbot".
 */
function slugBelongsTo(slug: string, toolkits: Set<string>): boolean {
  const s = slug.toLowerCase()
  for (const tk of toolkits) {
    if (s.startsWith(`${tk}_`)) return true
    if (tk.includes("_") && s.startsWith(`${tk.replace(/_/g, "")}_`)) return true
  }
  return false
}

/**
 * Run COMPOSIO_SEARCH_TOOLS for a batch of use cases (max 7 per call) and
 * return its `data`. Throws on a hard API failure rather than letting the
 * caller mistake it for "nothing connected" — the silent degradation that made
 * discovery report 0 tools after composio changed its session API.
 */
async function searchTools(connection: McpConnection, useCases: string[]): Promise<any> {
  const result = await callTool(connection, "COMPOSIO_SEARCH_TOOLS", {
    queries: useCases.map(use_case => ({ use_case })),
    session: { generate_id: true },
  }) as any
  const data = result?.data ?? result
  if (data?.error || data?.success === false) {
    const detail = typeof data.error === "string" ? data.error : data?.error?.message ?? "unknown error"
    throw new Error(
      `Composio tool discovery failed: ${detail}. The composio API may have changed — see src/mcp/discover/composio.ts.`,
    )
  }
  return data
}

export async function discover(connection: McpConnection): Promise<Tool[]> {
  const allSchemas: Record<string, any> = {}
  const allSlugs = new Set<string>()
  const connected = new Set<string>()

  // Collect tool slugs + inline schemas from a SEARCH_TOOLS response. Filtering
  // to connected toolkits happens later (a single pass), since the full set of
  // connected toolkits isn't known until the whole sweep finishes.
  const sweeps: any[] = []
  const collect = (data: any) => {
    Object.assign(allSchemas, data?.tool_schemas ?? {})
    sweeps.push(data)
  }

  // 1. Identify connected toolkits by sweeping a broad battery of use cases.
  //    SEARCH_TOOLS reports `toolkit_connection_statuses[].has_active_connection`
  //    for every toolkit a query surfaces — accurate to the live session.
  for (const batch of chunk(PROBE_QUERIES, 7)) {
    const data = await searchTools(connection, batch)
    collect(data)
    for (const status of data?.toolkit_connection_statuses ?? []) {
      if (status?.has_active_connection && status?.toolkit) {
        connected.add(String(status.toolkit).toLowerCase())
      }
    }
  }

  if (connected.size === 0) {
    console.log("[composio] No connected toolkits found. Connect a service in the Composio dashboard, then refresh.")
    return []
  }
  const connectedToolkits = [...connected]
  console.log(`[composio] Connected: ${connectedToolkits.join(", ")}`)

  // 2. Search each connected toolkit directly for a fuller tool set.
  for (const batch of chunk(connectedToolkits, 7)) {
    collect(await searchTools(connection, batch.map(tk => `${tk} actions`)))
  }

  // Harvest every tool slug from both phases that belongs to a connected
  // toolkit (drops meta-tools and cross-toolkit related results).
  for (const data of sweeps) {
    for (const r of data?.results ?? []) {
      for (const slug of [...(r.primary_tool_slugs ?? []), ...(r.related_tool_slugs ?? [])]) {
        if (slug.startsWith("COMPOSIO_") || slug.startsWith("RUBE_")) continue
        if (slugBelongsTo(slug, connected)) allSlugs.add(slug)
      }
    }
  }

  // 3. Build tools from schemas, collect slugs that need fetching
  const tools: Tool[] = []
  const needSchemas: string[] = []

  for (const slug of allSlugs) {
    const schema = allSchemas[slug]
    if (schema?.input_schema) {
      tools.push({
        name: slug.toLowerCase(),
        description: firstLineSummary(schema.description),
        inputSchema: schema.input_schema,
      })
    } else {
      needSchemas.push(slug)
    }
  }

  // 4. Fetch missing schemas via the MCP connection
  if (needSchemas.length > 0) {
    try {
      const result = await callTool(connection, "COMPOSIO_GET_TOOL_SCHEMAS", {
        tool_slugs: needSchemas,
      }) as any
      const fetched = result?.data?.tool_schemas ?? result?.tool_schemas ?? {}
      let fetchedCount = 0
      for (const slug of needSchemas) {
        const s = fetched[slug]
        if (s?.input_schema) {
          tools.push({
            name: slug.toLowerCase(),
            description: firstLineSummary(s.description),
            inputSchema: s.input_schema,
          })
          fetchedCount++
        }
      }
      if (fetchedCount < needSchemas.length) {
        console.log(`[composio] Could not fetch schemas for ${needSchemas.length - fetchedCount} tool(s) — they will be skipped`)
      }
    } catch (e: any) {
      console.log(`[composio] Failed to fetch ${needSchemas.length} tool schemas: ${e?.message ?? e}`)
    }
  }

  const toolkitNames = new Set(tools.map(t => t.name.split("_")[0]))
  console.log(`[composio] Discovered ${tools.length} tools across ${toolkitNames.size} toolkit(s)`)
  return tools
}

/**
 * Code inlined into the generated connection module.
 * Maps lowercase tool name back to uppercase slug for COMPOSIO_MULTI_EXECUTE_TOOL.
 * Delegates envelope unwrapping (and spill-file recovery for large responses)
 * to `unwrapComposioResult` so the logic stays testable in one place.
 */
export const proxyCallCode = `
    const slug = name.toUpperCase()
    const raw: any = await callTool(await conn(), "COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: slug, arguments: params ?? {} }],
      sync_response_to_workbench: false,
    })
    return unwrapComposioResult(raw)`

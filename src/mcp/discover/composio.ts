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
 * 1. Candidates. Two sources, unioned: the "User has manually connected the
 *    apps: ..." line Composio embeds in the COMPOSIO_SEARCH_TOOLS description
 *    (undocumented, but the one place the account's connections are stated
 *    outright), and a sweep of PROBE_QUERIES through COMPOSIO_SEARCH_TOOLS,
 *    whose `toolkit_connection_statuses[]` reports `has_active_connection` for
 *    every toolkit a query touches.
 * 2. Confirmation. One COMPOSIO_MANAGE_CONNECTIONS call with `action: "list"`
 *    over the candidates. Only toolkits already reported connected go in: the
 *    schema says `list` has no side effects, but an unconnected toolkit comes
 *    back "initiated", so it is a check, never a sweep over guesses. It also
 *    accepts unknown slugs silently, so it cannot validate names.
 * 3. Enumeration. Per connected toolkit, COMPOSIO_SEARCH_TOOLS "<toolkit>
 *    actions" with the default strategy and again with `tool_search` (each
 *    query returns only a handful of tools, and the two strategies overlap
 *    partially), then COMPOSIO_GET_TOOL_SCHEMAS for slugs without an inline
 *    schema.
 *
 * There is no list-all primitive on the OAuth MCP path: the session toolkit
 * endpoints and `preload.tools: "all"` need an API key, which jig does not
 * use. ComposioHQ/composio#3118 (a COMPOSIO_LIST_CONNECTED_TOOLKITS meta-tool)
 * was closed in May 2026 without one.
 *
 * Failure policy: a response without the fields discovery reads is an error,
 * not an empty account. Returning [] on a format change is how this module
 * once reported "authorized, no apps connected" for a working connection.
 *
 * To refresh tools after connecting new services: `jig connect composio`
 */
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import type { McpConnection } from "../client.js"
import { callTool, isRetryableServerError } from "../client.js"
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

/** Attempts and pauses for a call Composio's gateway answered with a transient upstream error. */
const UPSTREAM_RETRY_DELAYS_MS = [1_000, 3_000]

async function withUpstreamRetry<T>(label: string, delays: number[], run: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run()
    } catch (error) {
      if (attempt >= delays.length || !isRetryableServerError(error)) throw error
      console.log(`[composio] ${label} hit a transient upstream error, retrying`)
      await Bun.sleep(delays[attempt])
    }
  }
}

/**
 * Run COMPOSIO_SEARCH_TOOLS for a batch of use cases (max 7 per call) and
 * return its `data`. Throws on a hard API failure or a response without the
 * fields discovery reads, rather than letting the caller mistake either for
 * "nothing connected".
 */
async function searchTools(
  connection: McpConnection,
  useCases: string[],
  options: { strategy?: "auto" | "tool_search"; retryDelaysMs?: number[] } = {},
): Promise<any> {
  const result = await withUpstreamRetry("COMPOSIO_SEARCH_TOOLS", options.retryDelaysMs ?? UPSTREAM_RETRY_DELAYS_MS, () =>
    callTool(connection, "COMPOSIO_SEARCH_TOOLS", {
      queries: useCases.map(use_case => ({ use_case })),
      session: { generate_id: true },
      ...(options.strategy ? { search_strategy: options.strategy } : {}),
    }),
  ) as any
  const data = result?.data ?? result
  if (data?.error || data?.success === false) {
    const detail = typeof data.error === "string" ? data.error : data?.error?.message ?? "unknown error"
    throw new Error(
      `Composio tool discovery failed: ${detail}. The composio API may have changed — see src/mcp/discover/composio.ts.`,
    )
  }
  if (!Array.isArray(data?.results)) {
    const shape = Array.isArray(data) ? "an array of text parts" : `keys ${Object.keys(data ?? {}).join(", ") || "(none)"}`
    throw new Error(
      `Composio tool discovery failed: COMPOSIO_SEARCH_TOOLS returned no results array (got ${shape}). The response format may have changed; see src/mcp/discover/composio.ts.`,
    )
  }
  return data
}

/** Toolkit slugs from the "connected the apps: a, b, c" line in the SEARCH_TOOLS description, if Composio included one. */
export function connectedAppsHint(metaTools: Tool[]): Set<string> {
  const description = metaTools.find(t => t.name === "COMPOSIO_SEARCH_TOOLS")?.description ?? ""
  const match = description.match(/connected the apps:\s*([^\n.]+)/i)
  const slugs = (match?.[1] ?? "").split(",").map(s => s.trim().toLowerCase()).filter(s => /^[a-z0-9_]+$/.test(s))
  return new Set(slugs)
}

/**
 * Which of `candidates` have an active account, per COMPOSIO_MANAGE_CONNECTIONS
 * `action: "list"`. Returns null when the call or its shape fails, so the
 * caller can fall back to the search-reported set instead of losing discovery
 * over a confirmation step.
 */
async function confirmConnected(connection: McpConnection, candidates: string[], retryDelaysMs?: number[]): Promise<Set<string> | null> {
  try {
    const result = await withUpstreamRetry("COMPOSIO_MANAGE_CONNECTIONS", retryDelaysMs ?? UPSTREAM_RETRY_DELAYS_MS, () =>
      callTool(connection, "COMPOSIO_MANAGE_CONNECTIONS", {
        toolkits: candidates.map(name => ({ name, action: "list" })),
      }),
    ) as any
    const results = result?.data?.results ?? result?.results
    if (!results || typeof results !== "object") return null
    const active = new Set<string>()
    for (const [slug, entry] of Object.entries<any>(results)) {
      if (entry?.status === "active" && Array.isArray(entry?.accounts) && entry.accounts.length > 0) active.add(slug.toLowerCase())
    }
    return active
  } catch (error: any) {
    console.warn(`[composio] Could not confirm connections via COMPOSIO_MANAGE_CONNECTIONS: ${error?.message ?? error}`)
    return null
  }
}

export async function discover(
  connection: McpConnection,
  options: { metaTools?: Tool[]; retryDelaysMs?: number[] } = {},
): Promise<Tool[]> {
  const retry = options.retryDelaysMs
  const allSchemas: Record<string, any> = {}
  const allSlugs = new Set<string>()
  const sweeps: any[] = []
  const collect = (data: any) => {
    Object.assign(allSchemas, data?.tool_schemas ?? {})
    sweeps.push(data)
  }

  // 1. Candidates: Composio's own hint plus whatever the use-case sweep reports.
  const seeded = connectedAppsHint(options.metaTools ?? [])
  if (seeded.size > 0) console.log(`[composio] Composio lists as connected: ${[...seeded].join(", ")}`)

  const reported = new Set<string>()
  let statusesSeen = 0
  for (const batch of chunk(PROBE_QUERIES, 7)) {
    const data = await searchTools(connection, batch, { retryDelaysMs: retry })
    collect(data)
    for (const status of data?.toolkit_connection_statuses ?? []) {
      statusesSeen++
      if (status?.has_active_connection && status?.toolkit) reported.add(String(status.toolkit).toLowerCase())
    }
  }
  // Two dozen use cases touching no toolkit at all means the status field
  // moved, not that nothing is connected.
  if (statusesSeen === 0) {
    throw new Error(
      "Composio tool discovery failed: no toolkit_connection_statuses in any COMPOSIO_SEARCH_TOOLS response. The response format may have changed; see src/mcp/discover/composio.ts.",
    )
  }

  const candidates = [...new Set([...seeded, ...reported])]
  if (candidates.length === 0) {
    console.log("[composio] No connected toolkits found. Connect a service in the Composio dashboard, then refresh.")
    return []
  }

  // 2. Confirm with the account list; fall back to the reported set if that fails.
  const confirmed = await confirmConnected(connection, candidates, retry)
  const connected = confirmed ?? new Set(candidates)
  if (confirmed) {
    const dropped = candidates.filter(c => !confirmed.has(c))
    if (dropped.length > 0) console.log(`[composio] Not active per account list, skipping: ${dropped.join(", ")}`)
  }
  if (connected.size === 0) {
    console.log("[composio] No connected toolkits found. Connect a service in the Composio dashboard, then refresh.")
    return []
  }
  const connectedToolkits = [...connected]
  console.log(`[composio] Connected: ${connectedToolkits.join(", ")}`)

  // 3. Enumerate each connected toolkit with both search strategies.
  for (const batch of chunk(connectedToolkits, 7)) {
    const queries = batch.map(tk => `${tk} actions`)
    collect(await searchTools(connection, queries, { retryDelaysMs: retry }))
    collect(await searchTools(connection, queries, { strategy: "tool_search", retryDelaysMs: retry }))
  }

  // Harvest every tool slug from all phases that belongs to a connected
  // toolkit (drops meta-tools and cross-toolkit related results).
  for (const data of sweeps) {
    for (const r of data?.results ?? []) {
      for (const slug of [...(r.primary_tool_slugs ?? []), ...(r.related_tool_slugs ?? [])]) {
        if (slug.startsWith("COMPOSIO_") || slug.startsWith("RUBE_")) continue
        if (slugBelongsTo(slug, connected)) allSlugs.add(slug)
      }
    }
  }

  // 4. Build tools from inline schemas, collect slugs that need fetching.
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

  // 5. Fetch missing schemas via the MCP connection.
  if (needSchemas.length > 0) {
    try {
      const result = await withUpstreamRetry("COMPOSIO_GET_TOOL_SCHEMAS", retry ?? UPSTREAM_RETRY_DELAYS_MS, () =>
        callTool(connection, "COMPOSIO_GET_TOOL_SCHEMAS", { tool_slugs: needSchemas }),
      ) as any
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

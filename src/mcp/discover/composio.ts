/**
 * Composio tool discovery — finds real tools behind meta-tool orchestration.
 *
 * Composio's MCP server exposes 7 meta-tools instead of individual service tools.
 * This script runs during `jig connect composio` to discover the actual tools
 * (telegram_send_message, gmail_send_email, etc.) and generate typed wrappers.
 *
 * ## How discovery works
 *
 * 1. Call the session root endpoint via COMPOSIO_REMOTE_BASH_TOOL (sandbox has
 *    privileged access to backend.composio.dev with session credentials).
 *    The response's `config.auth_configs` is a map of `toolkit_slug → auth_config_id`
 *    listing ONLY the toolkits the user has actually connected.
 * 2. For each connected toolkit, call COMPOSIO_SEARCH_TOOLS to get tool slugs + schemas
 * 3. Fetch full schemas for tools that weren't returned inline
 *
 * ## Why the session root endpoint?
 *
 * We tried many other approaches:
 * - `COMPOSIO_SEARCH_TOOLS` via callTool returns stale/wrong connection statuses
 *   (MCP session context differs from user dashboard)
 * - `COMPOSIO_SEARCH_TOOLS` via raw HTTP with OAuth token works but requires
 *   probe queries and returns incomplete results (max 7 queries per call)
 * - `/toolkits` session endpoint lists enabled toolkits but `connected_account` is null
 * - `/connected_accounts`, `/connections`, etc. all return 404
 *
 * The session root (`GET /api/v3/tool_router/session/{id}`) is the only endpoint
 * that returns accurate, complete connection info for the current session, via
 * the sandbox's privileged `x-session-access-key`.
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

export async function discover(connection: McpConnection): Promise<Tool[]> {
  // 1. Query the session root endpoint to get connected toolkits.
  //    config.auth_configs is a map of toolkit_slug -> auth_config_id
  //    containing ONLY toolkits the user has actually connected.
  //    NOTE: This relies on Composio's internal env vars ($COMPOSIO_TOOLROUTER_SESSION_ID
  //    and $COMPOSIO_WORKBENCH_ACCESS_KEY) set inside their sandbox. If Composio renames
  //    these or changes the endpoint, discovery will break. Tracked in ComposioHQ/composio#3118.
  const sessionResult = await callTool(connection, "COMPOSIO_REMOTE_BASH_TOOL", {
    command: `curl -s "https://backend.composio.dev/api/v3/tool_router/session/$COMPOSIO_TOOLROUTER_SESSION_ID" -H "x-session-access-key: $COMPOSIO_WORKBENCH_ACCESS_KEY"`,
  }) as any

  let connectedToolkits: string[] = []
  try {
    const sessionData = JSON.parse(sessionResult?.data?.stdout ?? "{}")
    connectedToolkits = Object.keys(sessionData?.config?.auth_configs ?? {})
  } catch (e: any) {
    console.log(`[composio] Failed to parse session info: ${e?.message ?? e}`)
    return []
  }

  if (connectedToolkits.length === 0) {
    console.log("[composio] No connected toolkits. Connect services at composio.dev first.")
    return []
  }
  console.log(`[composio] Connected: ${connectedToolkits.join(", ")}`)

  // 2. Search for tools from each connected toolkit
  const allSchemas: Record<string, any> = {}
  const allSlugs = new Set<string>()

  // Batch into groups of 7 (COMPOSIO_SEARCH_TOOLS limit)
  const batches: string[][] = []
  for (let i = 0; i < connectedToolkits.length; i += 7) {
    batches.push(connectedToolkits.slice(i, i + 7))
  }

  for (const batch of batches) {
    const result = await callTool(connection, "COMPOSIO_SEARCH_TOOLS", {
      queries: batch.map(tk => ({ use_case: `${tk} actions` })),
      session: { generate_id: true },
    }) as any

    const data = result?.data ?? {}
    Object.assign(allSchemas, data.tool_schemas ?? {})

    for (const r of data.results ?? []) {
      for (const slug of [...(r.primary_tool_slugs ?? []), ...(r.related_tool_slugs ?? [])]) {
        if (!slug.startsWith("COMPOSIO_") && !slug.startsWith("RUBE_")) {
          allSlugs.add(slug)
        }
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
 */
export const proxyCallCode = `
    const slug = name.toUpperCase()
    const raw: any = await callTool(await conn(), "COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [{ tool_slug: slug, arguments: params ?? {} }],
      sync_response_to_workbench: false,
    })
    const execResult = raw?.data?.results?.[0] ?? {}
    return execResult?.response?.data ?? execResult?.response ?? raw`

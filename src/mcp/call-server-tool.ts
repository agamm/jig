/**
 * Call one tool on a configured server, handling the proxy servers.
 *
 * For a direct server this is `callTool`. For a proxy server (composio and
 * friends, marked by `config.proxy.via`) the cached tool names like
 * `googlecalendar_events_list` are not real MCP tools — they are dispatched
 * through a meta-tool and come back wrapped. This wraps and unwraps the same
 * way the generated jig binding does, so a caller sees what a jig would see.
 *
 * Extracted from services/introspect.ts, which had the only copy. Anything
 * needing live tool data (introspection, the scheduler's calendar source)
 * shares it rather than growing a second, subtly different version.
 */
import { acquireConnection, callTool } from "./client.js"
import { getServerConfig } from "./config.js"
import { unwrapComposioResult } from "./discover/composio-unwrap.js"

export async function callServerTool(
  server: string,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<unknown> {
  const config = await getServerConfig(server)
  const connection = await acquireConnection(server, config)

  const proxyVia = (config as any)?.proxy?.via
  if (typeof proxyVia !== "string" || proxyVia.length === 0) {
    return await callTool(connection, tool, args)
  }

  const raw = await callTool(connection, proxyVia, {
    tools: [{ tool_slug: tool.toUpperCase(), arguments: args }],
    sync_response_to_workbench: false,
  })
  // Lets ComposioSpillError propagate: an oversized response is a real failure
  // the caller must see, not something to paper over with a partial result.
  return await unwrapComposioResult(raw)
}

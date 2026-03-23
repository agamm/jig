import { getServerConfig } from "../mcp/config.js"
import { connectServer, discoverTools, callTool } from "../mcp/client.js"
import { isDryRun, isReadTool } from "./dryrun.js"
import type { JigTool } from "./jig.js"

// Cache: serverName → connected tool functions
const connectionCache = new Map<string, Record<string, JigTool<any, any>>>()
const pendingConnections = new Map<string, Promise<Record<string, JigTool<any, any>>>>()

/**
 * Connect to a server and return callable tool functions. Cached after first call.
 */
async function connectOnce(
  serverName: string
): Promise<Record<string, JigTool<any, any>>> {
  if (connectionCache.has(serverName)) return connectionCache.get(serverName)!
  if (pendingConnections.has(serverName)) return pendingConnections.get(serverName)!

  const promise = (async () => {
    const config = await getServerConfig(serverName)
    const connection = await connectServer(serverName, config)
    const tools = await discoverTools(connection)

    const toolFunctions: Record<string, JigTool<any, any>> = {}
    for (const tool of tools) {
      const fn = async (params: any) =>
        callTool(connection, tool.name, params ?? {})
      fn._serverName = serverName
      fn._toolName = tool.name
      toolFunctions[tool.name] = fn as JigTool<any, any>
    }

    connectionCache.set(serverName, toolFunctions)
    pendingConnections.delete(serverName)
    return toolFunctions
  })()

  pendingConnections.set(serverName, promise)
  return promise
}

/**
 * Create a lazy server proxy. Used by generated connection modules in .jig/connections/.
 * Tools auto-connect on first call. Fails clearly if server not set up.
 */
export function createLazyServer(
  serverName: string,
  toolNames: string[]
): Record<string, JigTool<any, any>> {
  const proxy: Record<string, JigTool<any, any>> = {}

  for (const toolName of toolNames) {
    const fn = async (params: any) => {
      if (isDryRun() && !isReadTool(toolName)) {
        console.log(`\n[dry-run] ${serverName}.${toolName}`)
        console.log(JSON.stringify(params, null, 2))
        return { _dryRun: true, tool: toolName, params }
      }
      const tools = await connectOnce(serverName)
      const tool = tools[toolName]
      if (!tool) {
        const available = Object.keys(tools).join(", ")
        throw new Error(
          `Tool "${toolName}" not found on "${serverName}". Available: ${available}`
        )
      }
      return tool(params)
    }
    fn._serverName = serverName
    fn._toolName = toolName
    proxy[toolName] = fn as JigTool<any, any>
  }

  return proxy
}

/**
 * Connection routes — the configured MCP server catalog, plus the custom
 * remote-server entry point. Connect/disconnect themselves live in
 * services/connect-server.ts; this module is the read + create surface.
 */
import { existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import { SCHEMAS_DIR, TYPES_DIR } from "../../config/paths.js"
import { ApiError, apiJson, json } from "../http.js"
import { createCustomRemoteServer, loadCustomServerConfigs, loadServerConfigs } from "../../mcp/config.js"
import { getConnectionStatus } from "../../services/connection-status.js"
import { connectConfiguredServer, isConnectInProgress } from "../../services/connect-server.js"
import { publicUrlFromRequest } from "../../config/runtime.js"
import { getActiveCode as getJigActiveCode } from "../../services/jig-store.js"
import { discoverAllJigs } from "../../services/jig-api.js"
import { extractConnections } from "../../domain/jig-source.js"
import { firstLineSummary } from "../../text.js"

export async function handleGetConnections(): Promise<Response> {
  const configs = await loadServerConfigs()
  const customConfigs = await loadCustomServerConfigs()
  const connections = await Promise.all(
    Object.entries(configs).map(async ([name, config]) => {
      const schemaPath = `${SCHEMAS_DIR}/${name}.json`
      const connected = existsSync(schemaPath)
      let toolCount = 0
      if (connected) {
        try {
          const schema = JSON.parse(readFileSync(schemaPath, "utf-8"))
          toolCount = Array.isArray(schema) ? schema.length : 0
        } catch {}
      }
      return {
        name,
        connected,
        toolCount,
        description: config.description,
        custom: Boolean(customConfigs[name]),
        proxyVia: config.proxy?.via,
        proxyDashboardUrl: config.proxy?.dashboardUrl,
        // "connected" only means the schema file exists; this carries the
        // runtime signal (token rejected / unreachable) the failure
        // chokepoints recorded.
        status: connected ? getConnectionStatus(name) : null,
        connectInProgress: isConnectInProgress(name),
      }
    })
  )
  return apiJson("connections", connections)
}

/** The generated `.d.ts` per connected server, so a jig can be typed and written away from the instance. */
export function handleGetConnectionTypes(): Response {
  const files: Record<string, string> = {}
  if (existsSync(TYPES_DIR)) {
    for (const name of readdirSync(TYPES_DIR).sort()) {
      if (name.endsWith(".d.ts")) files[name] = readFileSync(join(TYPES_DIR, name), "utf-8")
    }
  }
  return apiJson("connectionTypes", { files })
}

export async function handleGetConnection(name: string): Promise<Response> {
  if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new ApiError(400, "Invalid connection name")
  const configs = await loadServerConfigs()
  const customConfigs = await loadCustomServerConfigs()
  const config = (configs as Record<string, any>)[name]
  if (!config) throw new ApiError(404, `Connection not found: ${name}`)

  const schemaPath = join(SCHEMAS_DIR, `${name}.json`)
  const connected = existsSync(schemaPath)
  let tools: { name: string; description: string; readOnly: boolean; destructive: boolean }[] = []

  if (connected) {
    try {
      const schemas = JSON.parse(readFileSync(schemaPath, "utf-8"))
      tools = schemas.map((tool: any) => {
        const destructive = tool.annotations?.destructiveHint === true
        // Destructive tools are never read-only — normalize to avoid ambiguity
        const readOnly = !destructive && tool.annotations?.readOnlyHint === true
        return {
          name: tool.name,
          description: firstLineSummary(tool.description),
          readOnly,
          destructive,
        }
      })
    } catch {}
  }

  const usedBy: string[] = []
  for (const id of discoverAllJigs().keys()) {
    const code = getJigActiveCode(id)
    if (!code) continue
    if (extractConnections(code).includes(name)) usedBy.push(id)
  }

  return apiJson("getConnection", {
    name,
    connected,
    toolCount: tools.length,
    description: config.description ?? "",
    custom: Boolean(customConfigs[name]),
    proxyVia: config.proxy?.via,
    proxyDashboardUrl: config.proxy?.dashboardUrl,
    status: connected ? getConnectionStatus(name) : null,
    connectInProgress: isConnectInProgress(name),
    tools,
    usedBy,
  })
}

/**
 * Start a connection from the dashboard.
 *
 * The external request origin has to travel with the detached OAuth attempt:
 * hosted platforms can identify service mode before they publish a domain env
 * var, while the forwarded host still proves where the callback can land.
 */
export async function handleConnectConnection(
  req: Request,
  name: string,
  connect: typeof connectConfiguredServer = connectConfiguredServer,
): Promise<Response> {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  const body = await req.json().catch(() => ({})) as { credentials?: Record<string, string> }
  const result = await connect(name, {
    credentials: body.credentials,
    signal: req.signal,
    requestOrigin: publicUrlFromRequest(req),
  })
  return apiJson("connectConnection", result)
}

export async function handleCreateCustomConnection(body: any): Promise<Response> {
  const name = typeof body?.name === "string" ? body.name : ""
  const url = typeof body?.url === "string" ? body.url : ""
  const description = typeof body?.description === "string" ? body.description : ""

  if (!name.trim()) throw new ApiError(400, "Missing connection name")
  if (!url.trim()) throw new ApiError(400, "Missing MCP URL")

  try {
    const result = await createCustomRemoteServer({ name, url, description })
    return apiJson("createCustomConnection", {
      ok: true,
      connection: {
        name: result.name,
        connected: false,
        toolCount: 0,
        description: result.config.description,
        custom: true,
      },
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to create custom connection"
    if (message.startsWith("Connection already exists")) throw new ApiError(409, message)
    throw new ApiError(400, message)
  }
}

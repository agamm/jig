import { join } from "node:path"
import { loadServerConfigs, checkMissingCredentials, getServerConfig } from "../mcp/config.js"
import { setCredential } from "../db.js"
import { PROJECT_ROOT, SCHEMAS_DIR } from "../config/paths.js"
import { connectServer, discoverTools, ensureAnnotations } from "../mcp/client.js"
import { generateConnectionArtifacts } from "../mcp/typegen.js"

export type ConnectServerSuccess = {
  ok: true
  server: string
  toolCount: number
  tools: string[]
}

export type ConnectServerNeedsCredentials = {
  ok: false
  server: string
  missingCredentials: string[]
  setup?: string
}

export type ConnectServerResult = ConnectServerSuccess | ConnectServerNeedsCredentials

export async function connectConfiguredServer(
  serverName: string,
  input: { credentials?: Record<string, string> } = {}
): Promise<ConnectServerResult> {
  const configs = await loadServerConfigs()
  const rawConfig = configs[serverName]
  if (!rawConfig) {
    const available = Object.keys(configs).join(", ")
    throw new Error(`Unknown server "${serverName}". Available: ${available}`)
  }

  if (input.credentials) {
    for (const [key, value] of Object.entries(input.credentials)) {
      const trimmed = value.trim()
      if (!trimmed) continue
      setCredential(key, trimmed, serverName)
    }
  }

  const missingCredentials = checkMissingCredentials(rawConfig)
  if (missingCredentials.length > 0) {
    return {
      ok: false,
      server: serverName,
      missingCredentials,
      setup: (rawConfig as { setup?: string }).setup,
    }
  }

  const config = await getServerConfig(serverName)
  const connection = await connectServer(serverName, config)

  try {
    let tools = await discoverTools(connection)

    if (rawConfig.proxy?.connectDiscovery) {
      const { discover } = await import(join(PROJECT_ROOT, rawConfig.proxy.connectDiscovery))
      tools = await discover(connection)
    }

    await ensureAnnotations(tools)
    await Bun.write(join(SCHEMAS_DIR, `${serverName}.json`), JSON.stringify(tools, null, 2))
    await generateConnectionArtifacts()

    return {
      ok: true,
      server: serverName,
      toolCount: tools.length,
      tools: tools.map((tool) => tool.name),
    }
  } finally {
    await connection.transport.close().catch(() => {})
    await connection.client.close().catch(() => {})
  }
}

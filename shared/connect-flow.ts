import type { ConnectConnectionResponse, Connection } from "./api"

export type ConnectEvent =
  | { type: "server-list"; servers: { name: string; connected: boolean; toolCount: number; description: string }[] }
  | { type: "connecting"; server: string }
  | { type: "tools-discovered"; server: string; count: number; tools: string[] }
  | { type: "server-ready"; server: string }
  | { type: "setup-instructions"; message: string }
  | { type: "awaiting-oauth"; server: string; authorizationUrl: string; browserOpened?: boolean }
  | { type: "error"; code: string; message: string; details?: Record<string, any> }

export interface ConnectIO {
  ask(question: string): Promise<string>
  emit(event: ConnectEvent): void
}

export interface ConnectBackend {
  listConnections(): Promise<Connection[]>
  connect(name: string, credentials?: Record<string, string>): Promise<ConnectConnectionResponse>
  /** Pause between polls of a connect still running on the server; tests pass a no-op. */
  wait?(ms: number): Promise<void>
}

const IN_PROGRESS_POLL_MS = 2_000

/** Poll until the server-side connect finishes, then report what it left behind. */
async function awaitBackgroundConnect(serverName: string, backend: ConnectBackend): Promise<ConnectConnectionResponse> {
  const wait = backend.wait ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  for (;;) {
    const conn = (await backend.listConnections()).find((c) => c.name === serverName)
    if (conn && !conn.connectInProgress) {
      if (conn.connectError) throw new Error(`Connect to ${serverName} failed: ${conn.connectError}`)
      if (conn.connected && conn.status?.state !== "auth-required" && conn.status?.state !== "unreachable") {
        return { ok: true, server: serverName, toolCount: conn.toolCount, tools: [] }
      }
      throw new Error(`Connect to ${serverName} did not finish: ${conn.status?.detail ?? "no tools were saved; see the server logs"}`)
    }
    await wait(IN_PROGRESS_POLL_MS)
  }
}

export async function runConnectFlow(
  serverName: string | undefined,
  io: ConnectIO,
  backend: ConnectBackend
): Promise<void> {
  if (!serverName) {
    const servers = await backend.listConnections()
    io.emit({
      type: "server-list",
      servers: servers.map((server) => ({
        name: server.name,
        connected: server.connected,
        toolCount: server.toolCount,
        description: server.description,
      })),
    })
    return
  }

  io.emit({ type: "connecting", server: serverName })
  let result = await backend.connect(serverName)
  if (!result.ok && "inProgress" in result) result = await awaitBackgroundConnect(serverName, backend)
  if (!result.ok) {
    if ("awaitingOAuth" in result && result.awaitingOAuth) {
      io.emit({ type: "awaiting-oauth", server: serverName, authorizationUrl: result.authorizationUrl, browserOpened: result.browserOpened })
      // Background connect keeps running on the server; it resolves when the
      // OAuth callback fires. The frontend polls /api/connections/:name and
      // flips the UI to connected once the schema appears. Nothing else to
      // do here.
      return
    }
    if ("setup" in result && result.setup) io.emit({ type: "setup-instructions", message: result.setup })

    const credentials: Record<string, string> = {}
    const missing = "missingCredentials" in result ? result.missingCredentials : []
    for (const varName of missing) {
      const value = (await io.ask(`Enter ${varName}:`)).trim()
      if (!value) {
        io.emit({ type: "error", code: "missing-credential", message: `${varName} is required` })
        throw new Error(`${varName} is required`)
      }
      credentials[varName] = value
    }

    result = await backend.connect(serverName, credentials)
    if (!result.ok && "inProgress" in result) result = await awaitBackgroundConnect(serverName, backend)
    if (!result.ok) {
      if ("awaitingOAuth" in result && result.awaitingOAuth) {
        io.emit({ type: "awaiting-oauth", server: serverName, authorizationUrl: result.authorizationUrl, browserOpened: result.browserOpened })
        return
      }
      const missingAfter = "missingCredentials" in result ? result.missingCredentials : []
      const message = `Missing credentials: ${missingAfter.join(", ")}`
      io.emit({ type: "error", code: "missing-credential", message })
      throw new Error(message)
    }
  }

  io.emit({ type: "tools-discovered", server: serverName, count: result.toolCount, tools: result.tools })
  io.emit({ type: "server-ready", server: serverName })
}

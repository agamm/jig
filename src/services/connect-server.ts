import { join } from "node:path"
import { rm } from "node:fs/promises"
import { loadServerConfigs, checkMissingCredentials, getServerConfig } from "../mcp/config.js"
import { setCredential, deleteCredentials } from "../db.js"
import { CONNECTIONS_DIR, PROJECT_ROOT, SCHEMAS_DIR, TYPES_DIR } from "../config/paths.js"
import { closeConnection, connectServer, discoverTools, ensureAnnotations } from "../mcp/client.js"
import { generateConnectionArtifacts } from "../mcp/typegen.js"
import { isServiceMode } from "../config/runtime.js"
import { waitForPendingAuthUrl } from "../mcp/auth.js"
import { clearConnectionStatus, reportConnectionOk } from "./connection-status.js"

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

export type ConnectServerAwaitingOAuth = {
  ok: false
  awaitingOAuth: true
  server: string
  authorizationUrl: string
  browserOpened?: boolean
}

export type ConnectServerResult = ConnectServerSuccess | ConnectServerNeedsCredentials | ConnectServerAwaitingOAuth

/**
 * Detached connects still running after their HTTP request returned
 * (awaitingOAuth). Lets /api/connections report `connectInProgress` so the
 * dashboard can poll until the background connect actually finishes, and
 * dedupes a second Connect click into the same in-flight attempt.
 */
const inFlightConnects = new Map<string, Promise<ConnectServerSuccess | null>>()

export function isConnectInProgress(serverName: string): boolean {
  return inFlightConnects.has(serverName)
}

export async function connectConfiguredServer(
  serverName: string,
  input: { credentials?: Record<string, string>; signal?: AbortSignal; requestOrigin?: string } = {}
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

  // The caller is an HTTP request. We must NOT block it through an interactive
  // OAuth flow: a request held open through the browser dance is idle from the
  // server's perspective and gets closed by Bun's idleTimeout (30s) long before
  // a human finishes authorizing — which silently aborts the connect and breaks
  // EVERY OAuth connect (local and service alike).
  //
  // So: kick off connect detached, and race it against `waitForPendingAuthUrl`.
  // If an OAuth URL appears first, return it immediately (service mode: the
  // dashboard opens it; local mode: the browser was already auto-opened) and
  // let the connect resolve in the background when the callback fires — the
  // /api/oauth/callback handler hands over the code. The background connect
  // runs on its own AbortController, NOT req.signal, so the request returning
  // doesn't kill it; a generous timeout cleans up an abandoned authorization.
  //
  // Dedupe: if a connect for this server is already in flight (user clicked
  // Connect again, or polled into a second attempt), reuse it instead of
  // racing two OAuth flows for the same server.
  let detached = inFlightConnects.get(serverName)
  let lastConnectError: string | null = null
  if (!detached) {
    const oauthController = new AbortController()
    const oauthTimeout = setTimeout(() => oauthController.abort(), 10 * 60_000)
    detached = runConnectToCompletion(serverName, rawConfig, config, oauthController.signal, input.requestOrigin)
      .catch((err) => {
        lastConnectError = err?.message ?? String(err)
        console.error(`[connection] ${serverName} failed:`, lastConnectError)
        return null
      })
      .finally(() => {
        clearTimeout(oauthTimeout)
        inFlightConnects.delete(serverName)
      })
    inFlightConnects.set(serverName, detached)
  }

  const outcome = await Promise.race([
    detached.then((res) => ({ kind: "done" as const, res })),
    waitForPendingAuthUrl(serverName, 30_000).then((url) => ({ kind: "oauth" as const, url })),
  ])
  if (outcome.kind === "oauth" && outcome.url) {
    return {
      ok: false,
      awaitingOAuth: true,
      server: serverName,
      authorizationUrl: outcome.url,
      // Local mode auto-opens the browser server-side; tell the dashboard so it
      // doesn't pop a second tab to the same URL.
      browserOpened: !isServiceMode(),
    }
  }
  // `done` won (non-OAuth server, or it finished fast), or OAuth never staged a
  // URL within the window. Await the detached result either way.
  const finalRes = await detached
  if (!finalRes) {
    throw new Error(lastConnectError
      ? `Connect to ${serverName} failed: ${lastConnectError}`
      : `Connect to ${serverName} failed — see server logs`)
  }
  return finalRes
}

/**
 * Disconnect a configured server: close any live MCP client, drop its saved
 * credentials (OAuth tokens, client registration, verifier), and remove the
 * generated schema/typegen files so the dashboard shows it as "not connected".
 *
 * Safe to call on a server that was never connected — each step is
 * best-effort. Returns the set of things actually removed so callers can
 * surface an accurate summary.
 */
export async function disconnectConfiguredServer(serverName: string): Promise<{
  ok: true
  server: string
  removed: { credentials: boolean; schema: boolean; connection: boolean }
}> {
  const configs = await loadServerConfigs()
  if (!configs[serverName]) {
    throw new Error(`Unknown server "${serverName}". Available: ${Object.keys(configs).join(", ")}`)
  }

  // 1. Tear down any live MCP client so a subsequent tool call doesn't reuse
  // stale auth. Don't throw if nothing was open.
  let connectionClosed = false
  try {
    await closeConnection(serverName)
    connectionClosed = true
  } catch {}

  // 2. Wipe every credentials row for this server (oauth:*:tokens, client,
  // verifier, any provider-custom keys). Harmless if the row set was empty.
  deleteCredentials(serverName)
  // A deliberately disconnected server shouldn't keep showing "needs re-auth".
  clearConnectionStatus(serverName)

  // 3. Remove the generated schema + typed runtime so the UI flips to "not
  // connected" and tool lookups fail loudly instead of silently reusing an
  // old surface. Regenerate the connection index so other connections keep
  // their imports valid.
  const schemaPath = join(SCHEMAS_DIR, `${serverName}.json`)
  let schemaRemoved = false
  try {
    await rm(schemaPath, { force: true })
    schemaRemoved = true
  } catch {}
  try { await rm(join(CONNECTIONS_DIR, `${serverName}.ts`), { force: true }) } catch {}
  try { await rm(join(CONNECTIONS_DIR, `${serverName}.d.ts`), { force: true }) } catch {}
  try { await rm(join(TYPES_DIR, `${serverName}.d.ts`), { force: true }) } catch {}
  try { await generateConnectionArtifacts() } catch {}

  console.log(`[connection] ${serverName} disconnected`)

  return {
    ok: true,
    server: serverName,
    removed: { credentials: true, schema: schemaRemoved, connection: connectionClosed },
  }
}

async function runConnectToCompletion(
  serverName: string,
  rawConfig: Awaited<ReturnType<typeof loadServerConfigs>>[string],
  config: Awaited<ReturnType<typeof getServerConfig>>,
  signal?: AbortSignal,
  requestOrigin?: string,
): Promise<ConnectServerSuccess> {
  // Explicit connect flow — a human is driving it, so browser re-auth is OK.
  const connection = await connectServer(serverName, config, { signal, interactive: true, requestOrigin })
  try {
    let tools = await discoverTools(connection, { signal })

    if (rawConfig.proxy?.connectDiscovery) {
      const { discover } = await import(join(PROJECT_ROOT, rawConfig.proxy.connectDiscovery))
      tools = await discover(connection)
    }

    await ensureAnnotations(tools, { signal })
    await Bun.write(join(SCHEMAS_DIR, `${serverName}.json`), JSON.stringify(tools, null, 2))
    await generateConnectionArtifacts()
    // Connect succeeded — clear any stale auth-required/unreachable status so
    // the pane stops showing "Reconnect needed" next to "Connection ready".
    reportConnectionOk(serverName)
    console.log(`[connection] ${serverName} ready (${tools.length} tool${tools.length === 1 ? "" : "s"})`)

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

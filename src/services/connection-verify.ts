/**
 * Connection verification: does this connection actually work right now?
 *
 * The onboarding wizard advances one connection at a time and must never
 * advance on "a schema file exists on disk". That is the exact failure
 * `connection-status.ts` was written to complain about: a generated schema
 * survives an expired token, so the UI can show a green connection that
 * fails on its first real call.
 *
 * Two levels of proof, strongest first:
 *
 *   1. `probe` (configured per server as `meta.verify`): call one named
 *      read-only tool and summarise what came back. This is the only level
 *      that proves the connection returns usable DATA, so it is what the
 *      wizard wants for the connections it recommends.
 *   2. `handshake` (always available): open a live MCP connection and list
 *      tools. Expired or revoked credentials fail here, so it is a genuine
 *      auth check rather than a file-existence check, and it needs no
 *      per-server configuration.
 *
 * A server with no configured probe reports `handshake`, and callers are
 * expected to say so rather than claim a data-level check happened. Reporting
 * a handshake as a probe would recreate the lie this module exists to prevent.
 */
import { acquireConnection, discoverTools } from "../mcp/client.js"
import { getServerConfig, loadServerConfigs, type RemoteServerConfig, type StdioServerConfig } from "../mcp/config.js"
import { introspectToolOutput } from "./introspect.js"
import { reportConnectionIssue, reportConnectionOk } from "./connection-status.js"
import type { Shape } from "./introspect.js"
import type { VerifyConnectionResponse } from "../../shared/api.js"

/**
 * Largest array length anywhere in the shape descriptor, which is the most
 * useful single number for a human ("12 meetings visible"). Depth-limited
 * already by describeShape, so this cannot run away on a huge payload.
 */
function largestArrayLength(shape: Shape | undefined): number | null {
  if (!shape || typeof shape !== "object") return null
  const s = shape as Record<string, any>
  let best: number | null = null
  if (s.type === "array" && typeof s.length === "number") best = s.length
  const children: Shape[] = []
  if (s.item) children.push(s.item)
  if (s.keys && typeof s.keys === "object") children.push(...Object.values(s.keys as Record<string, Shape>))
  for (const child of children) {
    const nested = largestArrayLength(child)
    if (nested != null && (best == null || nested > best)) best = nested
  }
  return best
}

/**
 * One human-readable line. Prefers a count because "12 items" answers
 * "is this really working" better than a type name does.
 */
function summarise(server: string, tool: string, shape: Shape | undefined): string {
  const count = largestArrayLength(shape)
  if (count != null) return `${server}: ${tool} returned ${count} ${count === 1 ? "item" : "items"}`
  return `${server}: ${tool} responded`
}

/**
 * Verify one connection. Never throws: a verification failure is a result,
 * not an exception, because every caller wants to render it rather than
 * unwind. Records the outcome in connection-status so the dashboard's health
 * signal and the wizard agree instead of drifting apart.
 */
export async function verifyConnection(server: string): Promise<VerifyConnectionResponse> {
  const started = Date.now()

  // The registry entry carries `meta.verify`; getServerConfig returns the
  // RESOLVED stdio/remote config (repo servers already cloned and built) and
  // deliberately drops meta. Both are needed here.
  let config: StdioServerConfig | RemoteServerConfig
  let probe: { tool: string; args?: Record<string, unknown> } | undefined
  try {
    probe = (await loadServerConfigs())[server]?.meta?.verify
    config = await getServerConfig(server)
  } catch (error: any) {
    return { ok: false, server, level: "none", error: `Unknown connection "${server}": ${error?.message ?? error}` }
  }

  // Level 1: a configured read-only tool call. Delegates to introspectToolOutput
  // so the read-only gate, composio proxy unwrapping, spill detection and
  // redaction are the ones already used everywhere else.
  if (probe?.tool) {
    const result = await introspectToolOutput({ server, tool: probe.tool, args: probe.args ?? {} })
    if (result.ok) {
      reportConnectionOk(server)
      return {
        ok: true,
        server,
        level: "probe",
        tool: probe.tool,
        summary: summarise(server, probe.tool, result.shape as Shape),
        durationMs: Date.now() - started,
      }
    }
    // Fall through to the handshake rather than failing outright: a probe can
    // break because the provider renamed a tool, which says nothing about
    // whether the user's credentials work. Distinguishing those two is the
    // whole point of having two levels.
    const handshake = await handshakeOnly(server, config, started)
    if (handshake.ok) {
      return { ...handshake, warning: `Probe "${probe.tool}" failed (${result.error}); credentials are valid but the probe needs updating.` }
    }
    return handshake
  }

  return handshakeOnly(server, config, started)
}

/** Level 2: prove the credentials by opening a connection and listing tools. */
async function handshakeOnly(
  server: string,
  config: StdioServerConfig | RemoteServerConfig,
  started: number,
): Promise<VerifyConnectionResponse> {
  try {
    const connection = await acquireConnection(server, config)
    const tools = await discoverTools(connection)
    reportConnectionOk(server)
    return {
      ok: true,
      server,
      level: "handshake",
      toolCount: tools.length,
      summary: `${server}: authenticated, ${tools.length} ${tools.length === 1 ? "tool" : "tools"} available`,
      durationMs: Date.now() - started,
    }
  } catch (error: any) {
    const message = error?.message ?? String(error)
    // Mirror the failure into the durable status so an operator sees the same
    // thing here, on the Connections page, and in the failure email.
    reportConnectionIssue(server, /auth|401|403|unauthor/i.test(message) ? "auth-required" : "unreachable", message)
    return {
      ok: false,
      server,
      level: "handshake",
      error: message,
      hint: `Reconnect with "jig connect ${server}".`,
    }
  }
}

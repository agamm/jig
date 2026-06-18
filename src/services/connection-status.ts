/**
 * Connection status — durable per-server health written at the MCP failure
 * chokepoints (token rejected, reconnect exhausted) and cleared on successful
 * connect. The dashboard's Connections page reads this so "connected" means
 * "actually working", not just "schema file exists on disk".
 *
 * A broken transition also fires a debounced system notification (AgentMail) so
 * an unattended server tells the operator instead of failing silently.
 */
import { getSetting, setSetting } from "../db.js"
import { logSessionEvent } from "../debug/session-log.js"
import { notifySystem } from "./system-notify.js"
import { publicUrl } from "../config/runtime.js"
import type { ConnectionStatusInfo, ConnectionStatusState } from "../../shared/api.js"

const SETTING_PREFIX = "connection_status."

export function getConnectionStatus(server: string): ConnectionStatusInfo | null {
  const raw = getSetting<Partial<ConnectionStatusInfo>>(`${SETTING_PREFIX}${server}`)
  if (!raw || typeof raw.state !== "string" || typeof raw.at !== "string") return null
  return { state: raw.state as ConnectionStatusState, detail: raw.detail ?? undefined, at: raw.at }
}

function writeStatus(server: string, state: ConnectionStatusState, detail?: string): void {
  setSetting(`${SETTING_PREFIX}${server}`, {
    state,
    detail: detail ?? null,
    at: new Date().toISOString(),
  } satisfies Record<string, unknown>)
}

function dashboardConnectionsUrl(): string {
  const base = publicUrl() ?? `http://localhost:${process.env.JIG_DASHBOARD_PORT ?? "3141"}`
  return `${base}/?view=connections`
}

/**
 * Record that a connection is broken and needs operator attention.
 * Safe to call from any failure path — never throws.
 */
export function reportConnectionIssue(
  server: string,
  state: "auth-required" | "unreachable",
  detail: string,
): void {
  try {
    writeStatus(server, state, detail)
    const recoveryHint = state === "auth-required"
      ? `Re-authorize "${server}" from the dashboard Connections page.`
      : `Check that the "${server}" MCP server is reachable.`
    logSessionEvent({ source: "mcp.connection", event: state, server, error: detail, recoveryHint })
    void notifySystem({
      source: "mcp.connection",
      dedupeKey: `connection.${server}`,
      title: `Jig: connection "${server}" needs attention`,
      body: [
        state === "auth-required"
          ? `The "${server}" connection was rejected (expired or revoked credentials).`
          : `The "${server}" connection is unreachable after multiple reconnect attempts.`,
        ``,
        `Detail: ${detail}`,
        `Fix: ${recoveryHint}`,
        `Dashboard: ${dashboardConnectionsUrl()}`,
      ].join("\n"),
    })
  } catch {
    // Status bookkeeping must never break the calling failure path.
  }
}

/** Record a working connection. Skips the write when already ok. */
export function reportConnectionOk(server: string): void {
  try {
    const current = getConnectionStatus(server)
    if (current?.state === "ok") return
    writeStatus(server, "ok")
    if (current) logSessionEvent({ source: "mcp.connection", event: "recovered", server })
  } catch {}
}

export function clearConnectionStatus(server: string): void {
  try {
    setSetting(`${SETTING_PREFIX}${server}`, null)
  } catch {}
}

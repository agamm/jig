"use client"

import { useEffect, useRef, useState } from "react"
import { mutate } from "swr"
import { Button } from "@/components/button"
import { TextInput } from "@/components/input"
import { PaneHeader } from "@/components/pane-header"
import { PaneSection } from "@/components/pane-section"
import { RotatingFrame } from "@/components/rotating-frame"
import { ServiceIcon } from "@/components/service-icon"
import { EmptyState, LoadingState, Notice } from "@/components/state-panel"
import { connectConnection, disconnectConnection, fetchConnection, fetchConnections } from "@/lib/api"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { useConnection } from "@/lib/swr"
import { runConnectFlow } from "@shared/connect-flow"

/** Parse URL and return only if it's http/https. Blocks javascript: and other schemes. */
function safeExternalUrl(url: string): { href: string; hostname: string } | null {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null
    return { href: parsed.toString(), hostname: parsed.hostname }
  } catch {
    return null
  }
}

function formatConnectError(error: unknown): string {
  const message = error instanceof Error ? error.message : ""
  if (message === "Unknown API route") {
    return "The running Jig API is older than this dashboard build. Restart `jig start` and try connecting again."
  }
  if (
    message === "Cancelled by user"
    || message === "Request was aborted."
    || message === "This operation was aborted"
    || message === "Connect cancelled"
  ) {
    return "Connect cancelled."
  }
  return message || "Failed to connect"
}

function credentialKeyFromQuestion(question: string): string {
  const match = question.match(/^Enter (.+):$/)
  return match?.[1] ?? question
}

export function ConnectionPane({ name, onClose, onJigClick, standalone = false }: {
  name: string
  onClose: () => void
  onJigClick?: (jigId: string) => void
  standalone?: boolean
}) {
  const [search, setSearch] = useState("")
  const [connectStatus, setConnectStatus] = useState<string | null>(null)
  const [connecting, setConnecting] = useState(false)
  const [missingCredentials, setMissingCredentials] = useState<string[]>([])
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({})
  const [awaitingCredentialKey, setAwaitingCredentialKey] = useState<string | null>(null)
  const [oauthUrl, setOauthUrl] = useState<string | null>(null)
  const [confirmDisconnectOpen, setConfirmDisconnectOpen] = useState(false)
  const [disconnecting, setDisconnecting] = useState(false)
  const { data: conn, isLoading: loading, error, mutate: reload } = useConnection(name)
  const credentialValuesRef = useRef<Record<string, string>>({})
  const pendingCredentialRef = useRef<{
    key: string
    resolve: (value: string) => void
    reject: (error: Error) => void
  } | null>(null)
  const connectAbortRef = useRef<AbortController | null>(null)
  const connectRunRef = useRef(0)
  /** Connection state snapshot taken when OAuth started — see completion effect. */
  const oauthBaselineRef = useRef<{ connected: boolean; status?: string; sawInProgress: boolean } | null>(null)

  useEffect(() => {
    credentialValuesRef.current = credentialValues
  }, [credentialValues])

  useEffect(() => {
    if (!connecting || !conn?.connected) return
    setConnecting(false)
  }, [connecting, conn?.connected])

  useEffect(() => {
    return () => {
      connectAbortRef.current?.abort()
      const pending = pendingCredentialRef.current
      if (!pending) return
      pendingCredentialRef.current = null
      pending.reject(new Error("Connect cancelled"))
    }
  }, [])

  useEffect(() => {
    connectRunRef.current += 1
    connectAbortRef.current?.abort()
    connectAbortRef.current = null
    cancelPendingCredential("Connect cancelled")
    setConnecting(false)
    setConnectStatus(null)
    setMissingCredentials([])
    setCredentialValues({})
    setAwaitingCredentialKey(null)
    setOauthUrl(null)
    oauthBaselineRef.current = null
  }, [name])

  // Poll for completion while awaiting OAuth callback (and while the detached
  // server-side connect is still running after it).
  useEffect(() => {
    if (!oauthUrl && !conn?.connectInProgress) return
    const timer = setInterval(() => { void reload() }, 2000)
    return () => clearInterval(timer)
  }, [oauthUrl, conn?.connectInProgress, reload])

  // Completion detection. `conn.connected` alone is wrong for a RE-connect —
  // the schema file already exists, so it's true before OAuth even starts,
  // which used to flip the UI to "Connected." prematurely and leave the user
  // mashing Refresh. Instead wait for the server-side detached connect to
  // actually finish (connectInProgress true → false), with status/connected
  // transitions as fallbacks for older servers that don't report the flag.
  useEffect(() => {
    if (!oauthUrl || !conn) return
    const base = oauthBaselineRef.current
    if (conn.connectInProgress) {
      if (base) base.sawInProgress = true
      return
    }
    const finished =
      (base?.sawInProgress && conn.connectInProgress === false) ||
      (base?.status === "auth-required" && conn.status?.state === "ok") ||
      (!base?.connected && conn.connected)
    if (!finished) return
    setOauthUrl(null)
    oauthBaselineRef.current = null
    void mutate("connections")
    if (conn.connected && conn.status?.state !== "auth-required") {
      setConnectStatus(`Connected. ${conn.toolCount} tool${conn.toolCount === 1 ? "" : "s"} available.`)
    } else {
      setConnectStatus("Authorization didn't complete — click Connect to try again.")
    }
  }, [oauthUrl, conn])

  function prettifyUsedByLabel(jigId: string): string {
    return jigId
      .replace(/::/g, " / ")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase())
  }

  function cancelPendingCredential(message: string) {
    const pending = pendingCredentialRef.current
    if (!pending) return
    pendingCredentialRef.current = null
    setAwaitingCredentialKey(null)
    pending.reject(new Error(message))
  }

  function continuePendingCredential(): boolean {
    const pending = pendingCredentialRef.current
    if (!pending) return false
    const value = credentialValuesRef.current[pending.key]?.trim()
    if (!value) return false
    pendingCredentialRef.current = null
    setAwaitingCredentialKey(null)
    pending.resolve(value)
    return true
  }

  async function refreshConnectionState() {
    await mutate("connections")
    await reload(await fetchConnection(name), false)
  }

  async function handleConnect() {
    if (connecting) return
    if (!conn) return
    if (continuePendingCredential()) return
    if (awaitingCredentialKey) {
      setConnectStatus(`Enter ${awaitingCredentialKey} to continue.`)
      return
    }
    const controller = new AbortController()
    connectAbortRef.current = controller
    const runId = connectRunRef.current + 1
    connectRunRef.current = runId
    setConnecting(true)
    setConnectStatus(null)
    setMissingCredentials([])
    try {
      await runConnectFlow(conn.name, {
        ask: async (question: string) => {
          const key = credentialKeyFromQuestion(question)
          setMissingCredentials((prev) => prev.includes(key) ? prev : [...prev, key])
          setCredentialValues((prev) => key in prev ? prev : { ...prev, [key]: "" })
          setConnectStatus(`Enter ${key} to continue.`)

          const currentValue = credentialValuesRef.current[key]?.trim()
          if (currentValue) return currentValue

          return await new Promise<string>((resolve, reject) => {
            pendingCredentialRef.current = { key, resolve, reject }
            setAwaitingCredentialKey(key)
          })
        },
        emit: (event) => {
          switch (event.type) {
            case "connecting":
              setConnectStatus(`Connecting to ${event.server}...`)
              break
            case "setup-instructions":
              setConnectStatus(event.message)
              break
            case "tools-discovered":
              setConnectStatus(`Connected. Discovered ${event.count} tool${event.count === 1 ? "" : "s"}.`)
              break
            case "awaiting-oauth":
              setConnectStatus(`Opening authorization window for ${event.server}. If nothing opens, click the link below.`)
              oauthBaselineRef.current = {
                connected: !!conn?.connected,
                status: conn?.status?.state,
                sawInProgress: false,
              }
              setOauthUrl(event.authorizationUrl)
              // The user authorizes, the callback fires server-side, and the
              // background connect resolves. We poll fetchConnections to detect
              // completion. In local mode the browser was already auto-opened
              // server-side (browserOpened) — don't pop a second tab.
              if (typeof window !== "undefined" && !event.browserOpened) {
                try { window.open(event.authorizationUrl, "_blank", "noopener,noreferrer") } catch {}
              }
              break
            case "error":
              setConnectStatus(event.message)
              break
            default:
              break
          }
        },
      }, {
        listConnections: fetchConnections,
        connect: (name, credentials) => connectConnection(name, credentials, { signal: controller.signal }),
      })
      if (connectRunRef.current !== runId) return
      setMissingCredentials([])
      setCredentialValues({})
      await refreshConnectionState()
    } catch (e: unknown) {
      if (controller.signal.aborted) {
        if (connectRunRef.current === runId) setConnectStatus("Connect cancelled.")
        return
      }
      setConnectStatus(formatConnectError(e))
    } finally {
      if (connectRunRef.current === runId) {
        setConnecting(false)
        connectAbortRef.current = null
      }
    }
  }

  function handleCancelConnect() {
    connectAbortRef.current?.abort()
    connectAbortRef.current = null
    cancelPendingCredential("Connect cancelled")
    setConnecting(false)
    setConnectStatus("Connect cancelled.")
  }

  async function handleDisconnectConfirm() {
    if (disconnecting) return
    setDisconnecting(true)
    setConnectStatus(null)
    try {
      await disconnectConnection(name)
      setOauthUrl(null)
      setMissingCredentials([])
      setCredentialValues({})
      setConnectStatus("Disconnected.")
      await refreshConnectionState()
    } catch (e) {
      setConnectStatus(`Disconnect failed: ${(e as Error)?.message ?? String(e)}`)
    } finally {
      // Close the dialog either way — the error (if any) is visible in the
      // pane's status notice, which reads better than a dialog stuck open
      // behind a dimmed backdrop.
      setConfirmDisconnectOpen(false)
      setDisconnecting(false)
    }
  }

  return (
    <aside
      className={`flex flex-col bg-[#0e0e10] overflow-hidden ${standalone ? "w-full max-w-2xl mx-auto border-x border-[#1f1f23]" : "h-full w-full"}`}
    >
      <PaneHeader
        title={
          <span className="inline-flex items-center gap-2">
            <ServiceIcon name={name} size={18} />
            <span className="capitalize">{name}</span>
          </span>
        }
        badge={conn ? (
          <span className="inline-flex items-center gap-1">
            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${conn.connected ? "bg-emerald-500/10 text-emerald-400" : "bg-[#1a1a1d] text-[#555]"}`}>
              {conn.connected ? "Connected" : "Not connected"}
            </span>
            {conn.custom && (
              <span className="rounded-full border border-blue-500/20 bg-blue-500/[0.08] px-1.5 py-0.5 text-[9px] font-medium text-blue-300">
                custom
              </span>
            )}
            {conn.proxyVia && (
              <span
                className="rounded-full border border-[#2a2a2e] bg-[#1a1a1d] px-1.5 py-0.5 text-[9px] font-medium text-[#888]"
                title={`Tools proxied via ${conn.proxyVia}`}
              >
                proxy
              </span>
            )}
          </span>
        ) : undefined}
        actions={
          <Button
            onClick={() => {
              connectAbortRef.current?.abort()
              connectAbortRef.current = null
              setConnecting(false)
              cancelPendingCredential("Connect cancelled")
              onClose()
            }}
            variant="subtle"
            size="sm"
          >
            &#10005;
          </Button>
        }
      />

      <ConfirmDialog
        open={confirmDisconnectOpen}
        title={`Disconnect ${name}?`}
        message="Deletes stored OAuth tokens, closes the active MCP client, and removes generated tool schemas. Jigs that use this connection will fail until you reconnect."
        confirmLabel="Disconnect"
        destructive
        loading={disconnecting}
        onConfirm={handleDisconnectConfirm}
        onClose={() => !disconnecting && setConfirmDisconnectOpen(false)}
      />

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {loading && (
          <LoadingState message="Loading connection…" />
        )}

        {!loading && error && !conn && (
          <Notice
            tone="danger"
            title="Couldn’t load connection"
            actions={<Button onClick={() => reload()} variant="subtle" size="xs">Retry</Button>}
          >
            {error?.message ?? "Failed to load"}
          </Notice>
        )}

        {conn && (
          <>
            {conn.connected && conn.status && conn.status.state !== "ok" && (
              <Notice
                tone={conn.status.state === "auth-required" ? "warning" : "danger"}
                title={conn.status.state === "auth-required" ? "Reconnect needed" : "Connection unreachable"}
              >
                {conn.status.state === "auth-required"
                  ? "This connection's credentials were rejected (expired or revoked). Jigs using it will fail until you reconnect below."
                  : "Recent tool calls couldn't reach this server after retries. Check the provider, then refresh or reconnect below."}
                {conn.status.detail ? <span className="mt-1 block text-[10px] opacity-70">{conn.status.detail}</span> : null}
              </Notice>
            )}
            {conn.description && (
              <p className="text-[12px] text-[var(--text-muted)] leading-relaxed">{conn.description}</p>
            )}

            <RotatingFrame
              active={connecting}
              roundedClassName="rounded-lg"
              innerRoundedClassName="rounded-[7px]"
              surfaceClassName="bg-[#111113]"
            >
              <div className={`${connecting ? "" : "ui-card"} px-4 py-3 space-y-3`}>
                <div className="flex items-center justify-between gap-3">
                  <div>
                    <p className="text-[12px] text-[var(--text-primary)]">{conn.connected ? "Connection ready" : "Connect this service"}</p>
                    <p className="mt-1 text-[11px] text-[var(--text-dim)]">
                      {conn.connected ? "Refresh tool discovery if the provider added new capabilities." : "Starts the same backend connect flow used by the CLI."}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    {connecting && (
                      <Button onClick={handleCancelConnect} variant="danger" size="sm">
                        Cancel
                      </Button>
                    )}
                    {conn.connected && !connecting && (
                      <Button
                        onClick={() => setConfirmDisconnectOpen(true)}
                        variant="subtle"
                        size="sm"
                        disabled={disconnecting}
                      >
                        {disconnecting ? "Disconnecting…" : "Disconnect"}
                      </Button>
                    )}
                    <Button
                      onClick={handleConnect}
                      variant={conn.connected ? "subtle" : "success"}
                      size="sm"
                      disabled={awaitingCredentialKey ? !credentialValues[awaitingCredentialKey]?.trim() : connecting}
                    >
                      {awaitingCredentialKey ? "Continue" : connecting ? "Connecting…" : conn.connected ? "Refresh Tools" : "Connect"}
                    </Button>
                  </div>
                </div>

                {missingCredentials.length > 0 && (
                  <Notice tone="neutral" title="Credentials required" className="bg-[var(--surface-input)]">
                    <div className="space-y-2">
                      <p>Additional credentials are required before this connection can start.</p>
                      {missingCredentials.map((key) => (
                        <TextInput
                          key={key}
                          type="password"
                          placeholder={key}
                          value={credentialValues[key] ?? ""}
                          onChange={(e) => setCredentialValues((prev) => ({ ...prev, [key]: e.target.value }))}
                        />
                      ))}
                    </div>
                  </Notice>
                )}

                {oauthUrl ? (
                  <Notice tone="neutral" title="Authorize in a new tab">
                    <div className="space-y-2">
                      <p className="text-[11px] text-[var(--text-muted)]">
                        A new tab should have opened. If it didn't (popup blocker?), click the link below. After authorizing, this pane will update automatically.
                      </p>
                      <a
                        href={oauthUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="inline-flex items-center gap-1.5 rounded-md border border-emerald-500/30 bg-emerald-500/[0.08] px-2.5 py-1.5 text-[11px] text-emerald-300 hover:bg-emerald-500/[0.14]"
                      >
                        Open authorization URL <span>↗</span>
                      </a>
                    </div>
                  </Notice>
                ) : null}
                {connectStatus ? (
                  <Notice tone={connectStatus.toLowerCase().startsWith("connected") ? "success" : connectStatus.toLowerCase().includes("failed") || connectStatus.toLowerCase().includes("error") ? "danger" : "neutral"}>
                    <div className="whitespace-pre-wrap">{connectStatus}</div>
                  </Notice>
                ) : null}
              </div>
            </RotatingFrame>

            {(() => {
              const dash = conn.proxyDashboardUrl ? safeExternalUrl(conn.proxyDashboardUrl) : null
              if (!dash) return null
              return (
                <a
                  href={dash.href}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-md border border-[#1f1f23] bg-[#111113] px-2.5 py-1.5 text-[11px] text-[#ccc] hover:border-[#2a2a2e] hover:bg-[#151517] transition-colors"
                >
                  Manage connections at {dash.hostname}
                  <span className="text-[#555]">↗</span>
                </a>
              )
            })()}

            <PaneSection
              title="Tools"
              meta={<span className="text-[10px] text-[#444]">{conn.toolCount}</span>}
            >
              {conn.tools.length === 0 ? (
                <EmptyState title="No tools discovered yet" description="Connect the service to load its tool catalog." />
              ) : (
                <>
                  <div className="mb-2">
                    <TextInput
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Filter tools…"
                    />
                  </div>
                  <div className="rounded-lg border border-[#1f1f23] bg-[#111113] divide-y divide-[#1a1a1d] max-h-[400px] overflow-y-auto">
                    {conn.tools
                      .filter(t => !search || t.name.toLowerCase().includes(search.toLowerCase()) || t.description.toLowerCase().includes(search.toLowerCase()))
                      .map(tool => (
                        <div key={tool.name} className="px-3 py-2.5">
                          <div className="flex items-center gap-2 mb-0.5">
                            <span className="text-[11px] font-mono text-[#ccc]">{tool.name}</span>
                            {tool.destructive ? (
                              <span className="rounded-full bg-red-500/10 px-1.5 py-0.5 text-[8px] text-red-400" title="Destructive — modifies or deletes data permanently">destructive</span>
                            ) : tool.readOnly ? (
                              <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[8px] text-blue-400" title="Read-only — no side effects">read</span>
                            ) : (
                              <span className="rounded-full bg-amber-500/10 px-1.5 py-0.5 text-[8px] text-amber-400" title="Write — creates or updates data">write</span>
                            )}
                          </div>
                          {tool.description && (
                            <p className="text-[10px] text-[#555] leading-relaxed">{tool.description}</p>
                          )}
                        </div>
                      ))
                    }
                  </div>
                </>
              )}
            </PaneSection>

            {conn.usedBy.length > 0 && (
              <PaneSection title="Used By">
                <div className="flex flex-wrap gap-1.5">
                  {conn.usedBy.map(jigId => (
                    <button
                      key={jigId}
                      onClick={() => onJigClick?.(jigId)}
                      className="rounded-md border border-[#1f1f23] bg-[#111113] px-2.5 py-1.5 text-[11px] text-[#ccc] hover:border-[#2a2a2e] hover:bg-[#151517] transition-colors"
                    >
                      {prettifyUsedByLabel(jigId)}
                    </button>
                  ))}
                </div>
              </PaneSection>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

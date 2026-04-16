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
import { connectConnection, fetchConnections } from "@/lib/api"
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
  const { data: conn, isLoading: loading, error, mutate: reload } = useConnection(name)
  const credentialValuesRef = useRef<Record<string, string>>({})
  const pendingCredentialRef = useRef<{
    key: string
    resolve: (value: string) => void
    reject: (error: Error) => void
  } | null>(null)
  const connectAbortRef = useRef<AbortController | null>(null)
  const connectRunRef = useRef(0)

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
  }, [name])

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
      await mutate("connections")
      await reload()
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

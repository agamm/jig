"use client"

import { useEffect, useRef, useState } from "react"
import { mutate } from "swr"
import { Button } from "@/components/button"
import { PaneHeader } from "@/components/pane-header"
import { PaneSection } from "@/components/pane-section"
import { ServiceIcon } from "@/components/service-icon"
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

  useEffect(() => {
    credentialValuesRef.current = credentialValues
  }, [credentialValues])

  useEffect(() => {
    if (!connecting || !conn?.connected) return
    setConnecting(false)
  }, [connecting, conn?.connected])

  useEffect(() => {
    return () => {
      const pending = pendingCredentialRef.current
      if (!pending) return
      pendingCredentialRef.current = null
      pending.reject(new Error("Connect cancelled"))
    }
  }, [])

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
    if (!conn) return
    if (continuePendingCredential()) return
    if (awaitingCredentialKey) {
      setConnectStatus(`Enter ${awaitingCredentialKey} to continue.`)
      return
    }
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
        connect: connectConnection,
      })
      setMissingCredentials([])
      setCredentialValues({})
      await mutate("connections")
      await reload()
    } catch (e: unknown) {
      setConnectStatus(formatConnectError(e))
    } finally {
      setConnecting(false)
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
          <div className="flex items-center justify-center py-8 text-[#555] text-[11px]">Loading...</div>
        )}

        {!loading && error && !conn && (
          <div className="rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-4 space-y-3">
            <p className="text-[12px] text-[#888]">{error?.message ?? "Failed to load"}</p>
            <Button onClick={() => reload()} variant="subtle" size="xs">Retry</Button>
          </div>
        )}

        {conn && (
          <>
            {/* Description */}
            {conn.description && (
              <p className="text-[12px] text-[#888] leading-relaxed">{conn.description}</p>
            )}

            <div className={`relative rounded-lg border border-[#1f1f23] bg-[#111113] px-4 py-3 space-y-3 ${connecting ? "overflow-hidden" : ""}`}>
              {connecting && (
                <>
                  <div className="absolute inset-0 overflow-hidden rounded-lg">
                    <div
                      className="absolute inset-[-200%]"
                      style={{
                        animation: "spin-light 3s linear infinite",
                        background: "conic-gradient(transparent 240deg, rgba(96,165,250,0.3) 260deg, rgba(96,165,250,0.7) 275deg, rgba(96,165,250,1) 280deg, rgba(96,165,250,0.7) 285deg, rgba(96,165,250,0.3) 300deg, transparent 320deg)",
                      }}
                    />
                  </div>
                  <div className="absolute inset-[1px] rounded-[7px] bg-[#111113]" />
                </>
              )}
              <div className={`flex items-center justify-between gap-3 ${connecting ? "relative z-10" : ""}`}>
                <div>
                  <p className="text-[12px] text-[#ededed]">{conn.connected ? "Connection ready" : "Connect this service"}</p>
                  <p className="mt-1 text-[11px] text-[#666]">
                    {conn.connected ? "Refresh tool discovery if the provider added new capabilities." : "Starts the same backend connect flow used by the CLI."}
                  </p>
                </div>
                <Button
                  onClick={handleConnect}
                  variant={conn.connected ? "subtle" : "success"}
                  size="sm"
                  disabled={awaitingCredentialKey ? !credentialValues[awaitingCredentialKey]?.trim() : connecting}
                >
                  {awaitingCredentialKey ? "Continue" : connecting ? "Connecting..." : conn.connected ? "Refresh Tools" : "Connect"}
                </Button>
              </div>

              {missingCredentials.length > 0 && (
                <div className={`space-y-2 rounded-lg border border-[#1f1f23] bg-[#0d0d0f] px-3 py-3 ${connecting ? "relative z-10" : ""}`}>
                  <p className="text-[11px] text-[#888]">Additional credentials are required before this connection can start.</p>
                  {missingCredentials.map((key) => (
                    <input
                      key={key}
                      type="password"
                      placeholder={key}
                      value={credentialValues[key] ?? ""}
                      onChange={(e) => setCredentialValues((prev) => ({ ...prev, [key]: e.target.value }))}
                      className="w-full rounded-md border border-[#1f1f23] bg-[#09090b] px-2.5 py-1.5 text-[11px] text-[#ededed] placeholder:text-[#444] outline-none focus:border-[#2a2a2e] transition-colors"
                    />
                  ))}
                </div>
              )}

              {connectStatus && (
                <div className={`rounded-md border border-[#1f1f23] bg-[#0d0d0f] px-3 py-2 text-[11px] text-[#888] whitespace-pre-wrap ${connecting ? "relative z-10" : ""}`}>
                  {connectStatus}
                </div>
              )}
            </div>

            {/* Proxy: add more connections at provider's dashboard */}
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
                <p className="text-[11px] text-[#555]">
                  No tools discovered yet.
                </p>
              ) : (
                <>
                  <div className="mb-2">
                    <input
                      type="text"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      placeholder="Filter tools..."
                      className="w-full rounded-md border border-[#1f1f23] bg-[#111113] px-2.5 py-1.5 text-[11px] text-[#ededed] placeholder:text-[#444] outline-none focus:border-[#2a2a2e] transition-colors"
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

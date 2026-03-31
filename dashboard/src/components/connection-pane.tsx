"use client"

import { useEffect, useState } from "react"
import { ServiceIcon } from "@/components/service-icon"

type ConnectionDetail = {
  name: string
  description: string
  connected: boolean
  toolCount: number
  tools: { name: string; description: string; readOnly: boolean }[]
  usedBy: string[]
}

export function ConnectionPane({ name, onClose, onJigClick, standalone = false }: {
  name: string
  onClose: () => void
  onJigClick?: (jigId: string) => void
  standalone?: boolean
}) {
  const [conn, setConn] = useState<ConnectionDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState("")

  useEffect(() => {
    setLoading(true)
    fetch(`/api/connections/${encodeURIComponent(name)}`)
      .then(r => r.ok ? r.json() : null)
      .then(setConn)
      .catch(() => setConn(null))
      .finally(() => setLoading(false))
  }, [name])

  function prettifyUsedByLabel(jigId: string): string {
    return jigId
      .replace(/::/g, " / ")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase())
  }

  return (
    <aside
      className={`flex shrink-0 flex-col border-l border-[#1f1f23] bg-[#0e0e10] overflow-hidden ${standalone ? "w-full max-w-2xl mx-auto border-x" : "w-[48%]"}`}
      style={{ animation: "slide-in-right 0.2s ease" }}
    >
      {/* Header */}
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-[#1f1f23] px-4 gap-3">
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <ServiceIcon name={name} size={18} />
          <h2 className="text-[14px] font-semibold text-[#ededed] capitalize">{name}</h2>
          {conn && (
            <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${conn.connected ? "bg-emerald-500/10 text-emerald-400" : "bg-[#1a1a1d] text-[#555]"}`}>
              {conn.connected ? "Connected" : "Not connected"}
            </span>
          )}
        </div>
        <button
          onClick={onClose}
          className="rounded-md border border-[#1f1f23] bg-[#111113] px-2 py-1 text-[11px] text-[#555] transition-colors duration-150 hover:text-[#888] hover:bg-[#1a1a1d]"
        >
          &#10005;
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-5">
        {loading && (
          <div className="flex items-center justify-center py-8 text-[#555] text-[11px]">Loading...</div>
        )}

        {!loading && !conn && (
          <p className="text-[12px] text-[#555]">Connection not found.</p>
        )}

        {conn && (
          <>
            {/* Description */}
            {conn.description && (
              <p className="text-[12px] text-[#888] leading-relaxed">{conn.description}</p>
            )}

            {/* Tools */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider">
                  Tools <span className="text-[#444]">{conn.toolCount}</span>
                </h3>
              </div>
              {conn.tools.length === 0 ? (
                <p className="text-[11px] text-[#555]">
                  No tools discovered. Run <code className="text-[10px] bg-[#1a1a1d] px-1 py-0.5 rounded font-mono">jig connect {conn.name}</code>
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
                            {tool.readOnly && (
                              <span className="rounded-full bg-blue-500/10 px-1.5 py-0.5 text-[8px] text-blue-400">read-only</span>
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
            </div>

            {/* Used by */}
            {conn.usedBy.length > 0 && (
              <div>
                <h3 className="text-[11px] font-medium text-[#555] uppercase tracking-wider mb-2">Used by</h3>
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
              </div>
            )}
          </>
        )}
      </div>
    </aside>
  )
}

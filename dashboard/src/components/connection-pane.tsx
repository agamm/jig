"use client"

import { useState } from "react"
import { Button } from "@/components/button"
import { PaneHeader } from "@/components/pane-header"
import { PaneSection } from "@/components/pane-section"
import { ServiceIcon } from "@/components/service-icon"
import { useConnection } from "@/lib/swr"

export function ConnectionPane({ name, onClose, onJigClick, standalone = false }: {
  name: string
  onClose: () => void
  onJigClick?: (jigId: string) => void
  standalone?: boolean
}) {
  const [search, setSearch] = useState("")
  const { data: conn, isLoading: loading, error, mutate: reload } = useConnection(name)

  function prettifyUsedByLabel(jigId: string): string {
    return jigId
      .replace(/::/g, " / ")
      .replace(/[-_]/g, " ")
      .replace(/\b\w/g, c => c.toUpperCase())
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
          <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-medium ${conn.connected ? "bg-emerald-500/10 text-emerald-400" : "bg-[#1a1a1d] text-[#555]"}`}>
            {conn.connected ? "Connected" : "Not connected"}
          </span>
        ) : undefined}
        actions={
          <Button onClick={onClose} variant="subtle" size="sm">
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

            <PaneSection
              title="Tools"
              meta={<span className="text-[10px] text-[#444]">{conn.toolCount}</span>}
            >
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

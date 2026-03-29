"use client"

import { useState, useEffect } from "react"

type Version = { sha: string; date: string; message: string }

export function JigVersions({ jigId, entity }: { jigId: string; entity?: string }) {
  const [versions, setVersions] = useState<Version[]>([])
  const [selectedSha, setSelectedSha] = useState<string | null>(null)
  const [code, setCode] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    setLoading(true)
    const params = entity ? `?entity=${encodeURIComponent(entity)}` : ""
    fetch(`/api/jigs/${encodeURIComponent(jigId)}/versions${params}`)
      .then(r => r.json())
      .then(data => { if (Array.isArray(data)) setVersions(data) })
      .catch(() => {})
      .finally(() => setLoading(false))
  }, [jigId, entity])

  const viewVersion = async (sha: string) => {
    if (selectedSha === sha) { setSelectedSha(null); setCode(null); return }
    setSelectedSha(sha)
    const params = entity ? `?entity=${encodeURIComponent(entity)}` : ""
    try {
      const res = await fetch(`/api/jigs/${encodeURIComponent(jigId)}/versions/${sha}${params}`)
      const data = await res.json()
      setCode(data.code ?? null)
    } catch { setCode(null) }
  }

  if (loading) return <p className="text-[10px] text-[#555] py-2">Loading versions...</p>
  if (versions.length === 0) return <p className="text-[10px] text-[#555] py-2">No version history</p>

  return (
    <div className="rounded-lg border border-[#1f1f23] bg-[#111113] divide-y divide-[#1a1a1d] max-h-[300px] overflow-y-auto">
      {versions.map(v => {
        const date = new Date(v.date)
        const dateStr = date.toLocaleDateString("en-US", { month: "short", day: "numeric" })
        const timeStr = date.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })

        return (
          <div key={v.sha}>
            <button
              onClick={() => viewVersion(v.sha)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-[#151517]"
            >
              <span className="text-[10px] font-mono text-[#555] w-14 shrink-0">{v.sha.slice(0, 7)}</span>
              <div className="flex-1 min-w-0">
                <span className="text-[11px] text-[#ccc] truncate block">{v.message}</span>
                <span className="text-[9px] text-[#444]">{dateStr} {timeStr}</span>
              </div>
              <span className={`text-[9px] text-[#333] transition-transform duration-150 shrink-0 ${selectedSha === v.sha ? "rotate-90" : ""}`}>&#9656;</span>
            </button>
            {selectedSha === v.sha && code !== null && (
              <div className="border-t border-[#1a1a1d] px-3 py-2.5" style={{ animation: "fade-up 0.15s ease" }}>
                <pre className="text-[10px] text-[#888] font-mono whitespace-pre-wrap max-h-48 overflow-y-auto leading-relaxed">{code}</pre>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

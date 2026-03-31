"use client"

import type { JigTool } from "@shared/api"
import { ServiceIcon } from "@/components/service-icon"

export function JigToolList({
  tools,
  emptyLabel = "No tools detected.",
}: {
  tools: JigTool[]
  emptyLabel?: string
}) {
  if (tools.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-[#1f1f23] px-4 py-4 text-[11px] text-[#444]">
        {emptyLabel}
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-[#1f1f23] bg-[#111113] divide-y divide-[#1a1a1d]">
      {tools.map((tool) => (
        <div key={`${tool.connection}:${tool.name}`} className="flex items-center gap-3 px-4 py-3">
          <ServiceIcon name={tool.connection} size={16} />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="text-[11px] font-mono text-[#ccc]">{tool.name}</span>
              <span className="text-[10px] text-[#555]">{tool.connection}</span>
            </div>
          </div>
          <span
            className={`shrink-0 rounded-full px-2 py-0.5 text-[10px] ${
              tool.readOnly
                ? "border border-emerald-500/20 bg-emerald-500/10 text-emerald-300"
                : "border border-amber-500/20 bg-amber-500/10 text-amber-300"
            }`}
          >
            {tool.readOnly ? "Read-only" : "Can write"}
          </span>
        </div>
      ))}
    </div>
  )
}

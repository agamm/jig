"use client"

import { useEffect, useRef } from "react"
import type { AgentEvent, AgentMetrics, AgentStatus } from "@shared/api"
import { AgentActivity } from "@/components/agent-activity"
import { Button } from "@/components/button"
import { ConnectionTag } from "@/components/connection-tag"

export function AgentPanel({
  events,
  status,
  onRetry,
  requiredConnections = [],
  suggestedConnections = [],
  metrics,
  onConnectionClick,
}: {
  events: AgentEvent[]
  status: AgentStatus
  onRetry?: () => void
  requiredConnections?: string[]
  suggestedConnections?: Array<{ name: string; connected: boolean }>
  metrics?: AgentMetrics
  onConnectionClick?: (name: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)

  // Auto-scroll to bottom when new events arrive so the latest
  // question/tool-call is always visible above the fold.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [events.length, status])

  if (status === "idle") return null

  return (
    <div
      ref={scrollRef}
      className="border-t border-[#1f1f23] px-4 py-3 max-h-[320px] overflow-y-auto"
      style={{ animation: "fade-up 0.15s ease" }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-medium text-[#555] uppercase tracking-wider">Agent</span>
        {status === "error" && onRetry && (
          <Button onClick={onRetry} variant="subtle" size="xs">Retry</Button>
        )}
      </div>
      {metrics && (
        <div className="mb-2 flex flex-wrap gap-2 text-[10px] text-[#666]">
          {metrics.model && (
            <span className="rounded-full border border-[#2a2a2e] bg-[#151517] px-2 py-1 font-mono">
              {metrics.model}
            </span>
          )}
          {metrics.round != null && (
            <span className="rounded-full border border-[#2a2a2e] bg-[#151517] px-2 py-1">
              round {metrics.round}
            </span>
          )}
          {metrics.activeTool && (
            <span className="rounded-full border border-[#2a2a2e] bg-[#151517] px-2 py-1 font-mono">
              tool {metrics.activeTool}
            </span>
          )}
          {metrics.estimatedPromptTokens != null && metrics.promptTokens == null && (
            <span className="rounded-full border border-[#2a2a2e] bg-[#151517] px-2 py-1">
              ~{metrics.estimatedPromptTokens.toLocaleString()} in
            </span>
          )}
          {metrics.totalTokens != null && (
            <span className="rounded-full border border-[#2a2a2e] bg-[#151517] px-2 py-1">
              {metrics.totalTokens.toLocaleString()} tokens
            </span>
          )}
          {metrics.promptTokens != null && metrics.completionTokens != null && (
            <span className="rounded-full border border-[#2a2a2e] bg-[#151517] px-2 py-1">
              {metrics.promptTokens.toLocaleString()} in / {metrics.completionTokens.toLocaleString()} out
            </span>
          )}
        </div>
      )}
      <AgentActivity events={events} status={status} />
      {status === "error" && suggestedConnections.length > 0 && (
        <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-emerald-400">Suggested Connections</p>
          <p className="mt-1 text-[11px] leading-relaxed text-emerald-100/75">
            {requiredConnections.length > 0
              ? "The planner suggested these connections. Open any one to inspect setup. Tags marked setup needed are blocking the agent."
              : "The planner suggested these connections for this jig. Open any one to inspect setup."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            {suggestedConnections.map(({ name, connected }) => (
              <ConnectionTag
                key={name}
                name={name}
                detail={connected ? "connected" : "setup needed"}
                onClick={onConnectionClick}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

"use client"

import type { AgentEvent, AgentStatus } from "@shared/api"
import { AgentActivity } from "@/components/agent-activity"
import { Button } from "@/components/button"

export function AgentPanel({ events, status, onRetry }: { events: AgentEvent[]; status: AgentStatus; onRetry?: () => void }) {
  if (status === "idle") return null

  return (
    <div className="border-t border-[#1f1f23] px-4 py-3 max-h-[200px] overflow-y-auto" style={{ animation: "fade-up 0.15s ease" }}>
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-medium text-[#555] uppercase tracking-wider">Agent</span>
        {status === "error" && onRetry && (
          <Button onClick={onRetry} variant="subtle" size="xs">Retry</Button>
        )}
      </div>
      <AgentActivity events={events} status={status} />
    </div>
  )
}

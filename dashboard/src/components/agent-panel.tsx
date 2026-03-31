"use client"

import type { AgentEvent, AgentStatus } from "@shared/api"
import { AgentActivity } from "@/components/agent-activity"

export function AgentPanel({ events, status }: { events: AgentEvent[]; status: AgentStatus }) {
  if (status === "idle") return null

  return (
    <div className="border-t border-[#1f1f23] px-4 py-3 max-h-[200px] overflow-y-auto" style={{ animation: "fade-up 0.15s ease" }}>
      <div className="mb-2">
        <span className="text-[10px] font-medium text-[#555] uppercase tracking-wider">Agent</span>
      </div>
      <AgentActivity events={events} status={status} />
    </div>
  )
}

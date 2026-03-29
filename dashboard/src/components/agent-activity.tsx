"use client"

import type { AgentEvent, AgentStatus } from "@/hooks/use-agent"
import { Spinner } from "@/components/spinner"

const toolIcons: Record<string, string> = {
  read_jig_file: "\u{1F4C4}",
  write_jig_file: "\u{270F}",
  check_jig: "\u{2713}",
  browse: "\u{1F310}",
  web_search: "\u{1F50D}",
}

function ToolCallCard({ event }: { event: AgentEvent & { type: "tool-call" } }) {
  const icon = toolIcons[event.tool] ?? "\u{2699}"
  const argsPreview = Object.entries(event.args)
    .filter(([k]) => k !== "code")
    .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 40) : JSON.stringify(v)}`)
    .join(", ")

  return (
    <div className="flex items-start gap-2 py-1.5">
      <span className="text-[11px] w-4 shrink-0 text-center">{icon}</span>
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="text-[11px] font-mono text-[#ccc]">{event.tool}</span>
          {argsPreview && <span className="text-[10px] text-[#555] truncate">{argsPreview}</span>}
        </div>
        {event.status === "done" && event.result && event.tool === "check_jig" && event.result !== "ok" && (
          <pre className="text-[9px] text-rose-400/80 font-mono mt-1 whitespace-pre-wrap max-h-24 overflow-y-auto">{event.result}</pre>
        )}
      </div>
      <span className="shrink-0">
        {event.status === "running" && <Spinner size={10} />}
        {event.status === "done" && <span className="text-[10px] text-emerald-400">{"\u2713"}</span>}
        {event.status === "error" && <span className="text-[10px] text-rose-400">{"\u2717"}</span>}
      </span>
    </div>
  )
}

function TextMessage({ content }: { content: string }) {
  return (
    <div className="py-1.5 text-[11px] text-[#aaa] leading-relaxed">
      {content}
    </div>
  )
}

export function AgentActivity({ events, status }: { events: AgentEvent[]; status: AgentStatus }) {
  if (events.length === 0 && status === "thinking") {
    return (
      <div className="flex items-center gap-2 py-2">
        <Spinner size={12} />
        <span className="text-[11px] text-[#666]">Thinking...</span>
      </div>
    )
  }

  return (
    <div className="divide-y divide-[#1a1a1d]">
      {events.map((event, i) => (
        <div key={i}>
          {event.type === "tool-call" && <ToolCallCard event={event} />}
          {event.type === "text" && <TextMessage content={event.content} />}
        </div>
      ))}
      {(status === "thinking" || status === "tool-calling") && (
        <div className="flex items-center gap-2 py-2">
          <Spinner size={10} />
          <span className="text-[10px] text-[#555]">{status === "thinking" ? "Thinking..." : "Running tools..."}</span>
        </div>
      )}
    </div>
  )
}

"use client"

import { useEffect, useMemo, useState } from "react"
import type { AgentEvent, AgentStatus } from "@shared/api"
import { formatElapsed } from "@/lib/format"
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

function QuestionBubble({ question }: { question: string }) {
  return (
    <div className="py-2" style={{ animation: "fade-up 0.15s ease" }}>
      <div className="rounded-lg border border-blue-500/20 bg-blue-500/[0.04] px-3 py-2.5">
        <p className="text-[9px] font-medium uppercase tracking-wider text-blue-400 mb-1">Question</p>
        <p className="text-[11px] text-[#ddd] leading-relaxed">{question}</p>
      </div>
    </div>
  )
}

function TextMessage({ content }: { content: string }) {
  return (
    <div className="py-1.5 text-[11px] text-[#aaa] leading-relaxed break-words whitespace-pre-wrap max-h-60 overflow-y-auto">
      {content}
    </div>
  )
}

function UserMessage({ content }: { content: string }) {
  return (
    <div className="py-2 flex justify-end" style={{ animation: "fade-up 0.15s ease" }}>
      <div className="max-w-[85%] rounded-lg border border-emerald-500/20 bg-emerald-500/[0.06] px-3 py-2 text-[11px] text-[#ededed] leading-relaxed whitespace-pre-wrap break-words">
        {content}
      </div>
    </div>
  )
}

function isAskUserDuplicateText(events: AgentEvent[], index: number): boolean {
  // Text messages that duplicate an ask_user question — skip them
  const event = events[index]
  if (event.type !== "text") return false
  // Check if any ask_user tool call has this same text as its result
  return events.some(
    (e) => e.type === "tool-call" && e.tool === "ask_user" && e.status === "done" && e.result === event.content
  )
}

export function AgentActivity({
  events,
  status,
  activeStartedAt,
}: {
  events: AgentEvent[]
  status: AgentStatus
  activeStartedAt?: number
}) {
  const active = status === "thinking" || status === "tool-calling"
  const [lastToolAt, setLastToolAt] = useState<number | null>(null)
  const [elapsed, setElapsed] = useState(0)
  const latestToolSignature = useMemo(() => {
    const latestEvent = events.at(-1)
    if (latestEvent?.type !== "tool-call") return null
    return `${events.length}:${latestEvent.tool}:${latestEvent.status}:${latestEvent.result ?? ""}`
  }, [events])

  useEffect(() => {
    if (!active) {
      setLastToolAt(null)
      setElapsed(0)
      return
    }

    if (activeStartedAt) {
      setLastToolAt(activeStartedAt)
      setElapsed(Math.round((Date.now() - activeStartedAt) / 1000))
      return
    }

    if (latestToolSignature) {
      setLastToolAt(Date.now())
      setElapsed(0)
      return
    }

    setLastToolAt((current) => current ?? Date.now())
  }, [active, activeStartedAt, latestToolSignature])

  useEffect(() => {
    if (!active || lastToolAt === null) {
      setElapsed(0)
      return
    }

    setElapsed(Math.round((Date.now() - lastToolAt) / 1000))
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - lastToolAt) / 1000))
    }, 1000)

    return () => clearInterval(timer)
  }, [active, lastToolAt])

  const timeStr = elapsed > 0 ? formatElapsed(elapsed) : ""

  if (events.length === 0 && status === "thinking") {
    return (
      <div className="flex items-center gap-2 py-2">
        <Spinner size={12} />
        <span className="text-[11px] text-[#666]">Thinking...{timeStr && <span className="text-[#444] ml-1">{timeStr}</span>}</span>
      </div>
    )
  }

  return (
    <div className="divide-y divide-[#1a1a1d]">
      {events.map((event, i) => {
        // ask_user tool call → render as question bubble instead of tool card
        if (event.type === "tool-call" && event.tool === "ask_user") {
          const question = event.status === "done" && event.result ? event.result : (event.args as any).question ?? ""
          return <QuestionBubble key={i} question={question} />
        }
        // Skip the text message that duplicates the ask_user question
        if (isAskUserDuplicateText(events, i)) return null
        return (
          <div key={i}>
            {event.type === "tool-call" && <ToolCallCard event={event} />}
            {event.type === "text" && <TextMessage content={event.content} />}
            {event.type === "user-message" && <UserMessage content={event.content} />}
          </div>
        )
      })}
      {active && (
        <div className="flex items-center gap-2 py-2">
          <Spinner size={10} />
          <span className="text-[10px] text-[#555]">
            {status === "thinking" ? "Thinking" : "Running tools"}...
            {timeStr && <span className="text-[#444] ml-1">{timeStr}</span>}
          </span>
        </div>
      )}
    </div>
  )
}

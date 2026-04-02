"use client"

import { useEffect, useRef, useState } from "react"
import { Button } from "@/components/button"

type AgentState = {
  sessionId: string | null
  status: string
  isActive: boolean
  isWaiting: boolean
  canSend: boolean
  sendMessage: (msg: string) => void
  startSession: (msg: string, jigId?: string) => void
  reset: () => void
}

export function AgentInput({
  agent,
  jigId,
  idlePlaceholder = "Describe a change...",
  variant = "default",
  externalValue,
}: {
  agent: AgentState
  jigId?: string
  idlePlaceholder?: string
  variant?: "default" | "create"
  externalValue?: string
}) {
  const [input, setInput] = useState("")
  const prevStatusRef = useRef(agent.status)

  // Sync from external value (e.g. tool removal instructions)
  useEffect(() => {
    if (externalValue !== undefined) setInput(externalValue)
  }, [externalValue])

  // Clear input when agent starts waiting for user response
  useEffect(() => {
    if (agent.status === "waiting" && prevStatusRef.current !== "waiting") {
      setInput("")
    }
    prevStatusRef.current = agent.status
  }, [agent.status])

  function handleSend() {
    const trimmed = input.trim()
    if (!trimmed || !agent.canSend) return

    if (agent.sessionId) {
      agent.sendMessage(trimmed)
    } else {
      agent.startSession(trimmed, jigId)
    }
    setInput("")
  }

  const placeholder = agent.isWaiting
    ? "Type your answer..."
    : agent.sessionId
      ? "Follow up..."
      : idlePlaceholder

  return (
    <div className="flex items-center gap-2 rounded-lg border border-[#1f1f23] bg-[#111113] px-3 py-2">
      <input
        type="text"
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={(e) => { if (e.key === "Enter") handleSend() }}
        placeholder={placeholder}
        disabled={!agent.canSend}
        className="flex-1 bg-transparent text-[12px] text-[#ededed] outline-none placeholder:text-[#555] disabled:opacity-50"
      />
      {(agent.status === "done" || agent.status === "error") && (
        <Button onClick={agent.reset} variant="subtle" size="xs">Clear</Button>
      )}
      <Button
        onClick={handleSend}
        disabled={!input.trim() || !agent.canSend}
        variant="success"
        size="xs"
      >
        {!agent.sessionId && variant === "create" ? "Create" : "\u2191"}
      </Button>
    </div>
  )
}

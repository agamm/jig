"use client"

import { useEffect, useRef } from "react"
import { Button } from "@/components/button"
import { useInputHistory } from "@/hooks/use-input-history"

type AgentState = {
  sessionId: string | null
  status: string
  isActive: boolean
  isWaiting: boolean
  canSend: boolean
  sendMessage: (msg: string) => Promise<boolean>
  startSession: (msg: string, jigId?: string) => Promise<boolean>
  reset: () => Promise<void>
}

export function AgentInput({
  agent,
  jigId,
  idlePlaceholder = "Describe a change...",
  variant = "default",
  externalValue,
  onExternalValueChange,
  autoFocus = false,
}: {
  agent: AgentState
  jigId?: string
  idlePlaceholder?: string
  variant?: "default" | "create"
  externalValue?: string
  onExternalValueChange?: (value: string) => void
  autoFocus?: boolean
}) {
  const prevStatusRef = useRef(agent.status)
  const inputRef = useRef<HTMLInputElement>(null)
  const input = useInputHistory({ externalValue, onExternalValueChange })

  // Clear input when agent starts waiting for user response
  useEffect(() => {
    if (agent.status === "waiting" && prevStatusRef.current !== "waiting") {
      input.clear()
    }
    prevStatusRef.current = agent.status
  }, [agent.status, input])

  useEffect(() => {
    if (!autoFocus) return
    const timer = window.setTimeout(() => {
      inputRef.current?.focus()
    }, 0)
    return () => window.clearTimeout(timer)
  }, [autoFocus])

  async function handleSend() {
    const trimmed = input.value.trim()
    if (!trimmed || !agent.canSend) return

    let ok = false
    if (agent.sessionId) {
      ok = await agent.sendMessage(trimmed)
    } else {
      ok = await agent.startSession(trimmed, jigId)
    }
    if (ok) input.commit(trimmed)
  }

  const placeholder = agent.isWaiting
    ? "Type your answer..."
    : agent.sessionId
      ? "Follow up..."
      : idlePlaceholder

  return (
    <div className="flex items-center gap-2 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 transition-colors duration-150 focus-within:border-emerald-500/40 focus-within:ring-1 focus-within:ring-emerald-500/20">
      <input
        ref={inputRef}
        type="text"
        value={input.value}
        onChange={(e) => input.setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            void handleSend()
            return
          }
          if (e.key === "ArrowUp") {
            e.preventDefault()
            input.browsePrevious()
            return
          }
          if (e.key === "ArrowDown") {
            e.preventDefault()
            input.browseNext()
          }
        }}
        placeholder={placeholder}
        disabled={!agent.canSend}
        autoFocus={autoFocus}
        className="flex-1 bg-transparent text-[12px] text-[var(--text-primary)] outline-none border-0 ring-0 focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 placeholder:text-[var(--text-dim)] disabled:opacity-50"
      />
      {(agent.status === "done" || agent.status === "error") && (
        <Button
          onClick={() => {
            input.clear()
            input.clearHistory()
            void agent.reset()
          }}
          variant="subtle"
          size="xs"
        >
          Clear
        </Button>
      )}
      <Button
        onClick={() => void handleSend()}
        disabled={!input.value.trim() || !agent.canSend}
        variant="success"
        size="xs"
      >
        {!agent.sessionId && variant === "create" ? "Create" : "\u2191"}
      </Button>
    </div>
  )
}

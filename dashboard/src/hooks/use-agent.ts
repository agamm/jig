import { useState, useCallback, useRef, useEffect } from "react"

export type AgentEvent =
  | { type: "tool-call"; tool: string; args: Record<string, any>; status: "running" | "done" | "error"; result?: string }
  | { type: "text"; content: string }

export type AgentStatus = "thinking" | "tool-calling" | "waiting" | "done" | "error" | "idle"

export function useAgent(onComplete?: (jigId?: string) => void) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [status, setStatus] = useState<AgentStatus>("idle")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [jigId, setJigId] = useState<string | undefined>()
  const abortRef = useRef<AbortController | null>(null)
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const eventIndexRef = useRef(0)

  const cleanup = useCallback(() => {
    abortRef.current?.abort()
    if (pollRef.current) clearInterval(pollRef.current)
    pollRef.current = null
  }, [])

  useEffect(() => cleanup, [cleanup])

  const poll = useCallback((sid: string) => {
    if (pollRef.current) clearInterval(pollRef.current)

    pollRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/agent/${sid}?since=${eventIndexRef.current}`)
        if (!res.ok) return
        const data = await res.json()

        if (data.events?.length) {
          setEvents(prev => [...prev, ...data.events])
          eventIndexRef.current += data.events.length
        }

        setStatus(data.status)
        if (data.jigId) setJigId(data.jigId)

        if (data.status === "done" || data.status === "error") {
          if (pollRef.current) clearInterval(pollRef.current)
          pollRef.current = null
          onComplete?.(data.jigId)
        }
      } catch {}
    }, 1000)
  }, [onComplete])

  const startSession = useCallback(async (instruction: string, targetJigId?: string, entity?: string) => {
    cleanup()
    const abort = new AbortController()
    abortRef.current = abort

    setEvents([])
    setStatus("thinking")
    setJigId(targetJigId)
    eventIndexRef.current = 0

    try {
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction, jigId: targetJigId, entity }),
        signal: abort.signal,
      })

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: "Request failed" }))
        setStatus("error")
        setEvents([{ type: "text", content: err.error ?? `HTTP ${res.status}` }])
        return
      }

      const data = await res.json()
      setSessionId(data.sessionId)
      if (data.jigId) setJigId(data.jigId)
      poll(data.sessionId)
    } catch (e: any) {
      if (!abort.signal.aborted) {
        setStatus("error")
        setEvents([{ type: "text", content: e?.message ?? "Unknown error" }])
      }
    }
  }, [cleanup, poll])

  const sendMessage = useCallback(async (message: string) => {
    if (!sessionId) return
    setStatus("thinking")

    try {
      await fetch(`/api/agent/${sessionId}/message`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      })
      poll(sessionId)
    } catch {}
  }, [sessionId, poll])

  const reset = useCallback(() => {
    cleanup()
    setEvents([])
    setStatus("idle")
    setSessionId(null)
    setJigId(undefined)
    eventIndexRef.current = 0
  }, [cleanup])

  return {
    events,
    status,
    sessionId,
    jigId,
    isActive: status === "thinking" || status === "tool-calling",
    startSession,
    sendMessage,
    reset,
  }
}

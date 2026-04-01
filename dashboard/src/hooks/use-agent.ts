import { useState, useCallback, useRef, useEffect } from "react"
import type { AgentEvent, AgentStatus } from "@shared/api"
import { fetchAgentStatus, sendAgentMessage, startAgentSession } from "@/lib/api"

export function useAgent(onComplete?: (jigId?: string) => void | Promise<void>) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [status, setStatus] = useState<AgentStatus>("idle")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [jigId, setJigId] = useState<string | null>(null)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCompleteRef = useRef(onComplete)
  const sinceRef = useRef(0)
  const generationRef = useRef(0)
  onCompleteRef.current = onComplete

  const cleanup = useCallback(() => {
    generationRef.current += 1
    sinceRef.current = 0
    if (pollRef.current) clearTimeout(pollRef.current)
    pollRef.current = null
  }, [])

  useEffect(() => cleanup, [cleanup])

  const poll = useCallback((sid: string, generation: number) => {
    const tick = async () => {
      if (generationRef.current !== generation) return
      try {
        const data = await fetchAgentStatus(sid, sinceRef.current)
        if (generationRef.current !== generation) return

        if (data.events?.length) {
          sinceRef.current = data.totalEvents
          setEvents((prev) => [...prev, ...data.events])
        }

        setStatus(data.status)
        setJigId(data.jigId ?? null)

        if (data.status === "done" || data.status === "error") {
          pollRef.current = null
          await onCompleteRef.current?.(data.jigId)
          return
        }
      } catch (e: any) {
        if (generationRef.current !== generation) return
        setStatus("error")
        setEvents((prev) => prev.length > 0 ? prev : [{ type: "text", content: e?.message ?? "Unknown error" }])
        pollRef.current = null
        return
      }

      pollRef.current = setTimeout(tick, 1000)
    }

    if (pollRef.current) clearTimeout(pollRef.current)
    void tick()
  }, [])

  const startSession = useCallback(async (instruction: string, targetJigId?: string) => {
    cleanup()
    const generation = generationRef.current

    setEvents([])
    setStatus("thinking")
    setJigId(null)
    sinceRef.current = 0

    try {
      const data = await startAgentSession(instruction, targetJigId)
      if (generationRef.current !== generation) return
      setSessionId(data.sessionId)
      setJigId(data.jigId ?? null)
      poll(data.sessionId, generation)
    } catch (e: any) {
      if (generationRef.current === generation) {
        setStatus("error")
        setEvents([{ type: "text", content: e?.message ?? "Unknown error" }])
      }
    }
  }, [cleanup, poll])

  const sendMessage = useCallback(async (message: string) => {
    if (!sessionId) return
    setStatus("thinking")

    try {
      await sendAgentMessage(sessionId, message)
      poll(sessionId, generationRef.current)
    } catch (e: any) {
      setStatus("error")
      setEvents((prev) => prev.concat({ type: "text", content: e?.message ?? "Unknown error" }))
    }
  }, [sessionId, poll])

  const reset = useCallback(() => {
    cleanup()
    setEvents([])
    setStatus("idle")
    setSessionId(null)
    setJigId(null)
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

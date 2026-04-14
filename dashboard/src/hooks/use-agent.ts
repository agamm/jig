import { useState, useCallback, useRef, useEffect } from "react"
import type { AgentConversationTurn, AgentEvent, AgentMetrics, AgentStatus } from "@shared/api"
import { fetchAgentStatus, sendAgentMessage, startAgentSession } from "@/lib/api"

type SuggestedConnection = {
  name: string
  connected: boolean
}

function extractSuggestedConnections(error: any): SuggestedConnection[] {
  if (Array.isArray(error?.details?.connectionStatuses)) {
    return error.details.connectionStatuses
      .filter((item: any) => item && typeof item.name === "string")
      .map((item: any) => ({ name: item.name, connected: item.connected === true }))
  }

  if (Array.isArray(error?.details?.suggestedConnections)) {
    return error.details.suggestedConnections
      .filter((name: any) => typeof name === "string")
      .map((name: string) => ({
        name,
        connected: !Array.isArray(error?.details?.requiredConnections) || !error.details.requiredConnections.includes(name),
      }))
  }

  return []
}

export function useAgent(onComplete?: (jigId?: string) => void | Promise<void>) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [status, setStatus] = useState<AgentStatus>("idle")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [jigId, setJigId] = useState<string | null>(null)
  const [requiredConnections, setRequiredConnections] = useState<string[]>([])
  const [suggestedConnections, setSuggestedConnections] = useState<SuggestedConnection[]>([])
  const [metrics, setMetrics] = useState<AgentMetrics | undefined>(undefined)
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const onCompleteRef = useRef(onComplete)
  const sinceRef = useRef(0)
  const generationRef = useRef(0)
  const conversationRef = useRef<AgentConversationTurn[]>([])
  onCompleteRef.current = onComplete

  const cleanup = useCallback(() => {
    generationRef.current += 1
    sinceRef.current = 0
    if (pollRef.current) clearTimeout(pollRef.current)
    pollRef.current = null
  }, [])

  useEffect(() => cleanup, [cleanup])

  const appendConversationTurn = useCallback((turn: AgentConversationTurn) => {
    const content = turn.content.trim()
    if (!content) return
    const previous = conversationRef.current[conversationRef.current.length - 1]
    if (previous && previous.role === turn.role && previous.content === content) return
    conversationRef.current = [...conversationRef.current, { role: turn.role, content }]
  }, [])

  const poll = useCallback((sid: string, generation: number) => {
    const tick = async () => {
      if (generationRef.current !== generation) return false
      try {
        const data = await fetchAgentStatus(sid, sinceRef.current)
        if (generationRef.current !== generation) return

        if (data.events?.length) {
          sinceRef.current = data.totalEvents
          for (const event of data.events) {
            if (event.type === "text" && event.content.trim()) {
              appendConversationTurn({ role: "assistant", content: event.content })
            }
          }
          setEvents((prev) => [...prev, ...data.events])
        }

        setStatus(data.status)
        setJigId(data.jigId ?? null)
        setMetrics(data.metrics)

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
  }, [appendConversationTurn])

  const startSession = useCallback(async (instruction: string, targetJigId?: string): Promise<boolean> => {
    cleanup()
    const generation = generationRef.current
    appendConversationTurn({ role: "user", content: instruction })
    const history = [...conversationRef.current]

    setEvents([])
    setStatus("thinking")
    setJigId(null)
    setRequiredConnections([])
    setSuggestedConnections([])
    setMetrics(undefined)
    sinceRef.current = 0

    try {
      const data = await startAgentSession(instruction, targetJigId, history)
      if (generationRef.current !== generation) return
      setSessionId(data.sessionId)
      setJigId(data.jigId ?? null)
      poll(data.sessionId, generation)
      return true
    } catch (e: any) {
      if (generationRef.current === generation) {
        setStatus("error")
        setEvents([{ type: "text", content: e?.message ?? "Unknown error" }])
        setRequiredConnections(Array.isArray(e?.details?.requiredConnections) ? e.details.requiredConnections : [])
        setSuggestedConnections(extractSuggestedConnections(e))
        setMetrics(undefined)
      }
      return false
    }
  }, [appendConversationTurn, cleanup, poll])

  const sendMessage = useCallback(async (message: string): Promise<boolean> => {
    if (!sessionId) return false
    setStatus("thinking")
    appendConversationTurn({ role: "user", content: message })
    const history = [...conversationRef.current]

    try {
      await sendAgentMessage(sessionId, message, history)
      poll(sessionId, generationRef.current)
      return true
    } catch (e: any) {
      setStatus("error")
      setEvents((prev) => prev.concat({ type: "text", content: e?.message ?? "Unknown error" }))
      return false
    }
  }, [appendConversationTurn, sessionId, poll])

  const reset = useCallback(() => {
    cleanup()
    setEvents([])
    setStatus("idle")
    setSessionId(null)
    setJigId(null)
    setRequiredConnections([])
    setSuggestedConnections([])
    setMetrics(undefined)
    conversationRef.current = []
  }, [cleanup])

  const isActive = status === "thinking" || status === "tool-calling"
  const isWaiting = status === "waiting"
  const canSend = !isActive || isWaiting

  return {
    events,
    status,
    sessionId,
    jigId,
    requiredConnections,
    suggestedConnections,
    metrics,
    isActive,
    isWaiting,
    canSend,
    startSession,
    sendMessage,
    reset,
  }
}

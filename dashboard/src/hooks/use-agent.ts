import { useState, useCallback, useRef, useEffect } from "react"
import type { AgentConversationTurn, AgentDraftApproval, AgentEvent, AgentMetrics, AgentStatus, AgentStatusResponse } from "@shared/api"
import { approveAgentDraft, closeAgentSession, sendAgentMessage, startAgentSession } from "@/lib/api"

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

/**
 * Connects to the agent's SSE stream for one session.
 *
 * Replaces the older polling-based hook. The browser's native EventSource
 * handles reconnect + Last-Event-ID; we just attach a listener and merge
 * incoming snapshot frames into local state. No generation counters, no
 * setTimeout loops, no separate conversation mirror.
 */
export function useAgent(
  onComplete?: (jigId?: string) => void | Promise<void>,
  options: { persistOnUnmount?: boolean } = {},
) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [status, setStatus] = useState<AgentStatus>("idle")
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [jigId, setJigId] = useState<string | null>(null)
  const [requiredConnections, setRequiredConnections] = useState<string[]>([])
  const [suggestedConnections, setSuggestedConnections] = useState<SuggestedConnection[]>([])
  const [metrics, setMetrics] = useState<AgentMetrics | undefined>(undefined)
  const [draftApproval, setDraftApproval] = useState<AgentDraftApproval | undefined>(undefined)
  const [conversation, setConversation] = useState<AgentConversationTurn[]>([])
  const sourceRef = useRef<EventSource | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  const closeStream = useCallback(() => {
    if (sourceRef.current) {
      try { sourceRef.current.close() } catch {}
      sourceRef.current = null
    }
  }, [])

  useEffect(() => () => {
    closeStream()
    if (options.persistOnUnmount) return
    const sid = sessionIdRef.current
    if (sid) void closeAgentSession(sid).catch(() => {})
  }, [closeStream, options.persistOnUnmount])

  const applySnapshot = useCallback((snapshot: AgentStatusResponse) => {
    if (snapshot.events?.length) {
      setEvents((prev) => [...prev, ...snapshot.events])
    }
    setStatus(snapshot.status)
    setJigId(snapshot.jigId ?? null)
    setMetrics(snapshot.metrics)
    setDraftApproval(snapshot.draftApproval)
    if (snapshot.conversationHistory) setConversation(snapshot.conversationHistory)
  }, [])

  const subscribe = useCallback((sid: string) => {
    closeStream()
    // EventSource auto-handles Last-Event-ID on reconnect.
    const source = new EventSource(`/api/agent/${encodeURIComponent(sid)}/stream`)
    sourceRef.current = source

    source.addEventListener("snapshot", (ev: MessageEvent) => {
      try {
        const snapshot = JSON.parse(ev.data) as AgentStatusResponse
        applySnapshot(snapshot)
        if (snapshot.status === "done" || snapshot.status === "error") {
          // Close stream — terminal state. onComplete callback fires once.
          closeStream()
          void onCompleteRef.current?.(snapshot.jigId)
        }
      } catch {
        /* ignore malformed frames */
      }
    })

    source.addEventListener("error", () => {
      // Native EventSource auto-reconnects with Last-Event-ID; only enter our
      // error state if the connection is closed permanently.
      if (source.readyState === EventSource.CLOSED) {
        setStatus((current) => current === "thinking" || current === "tool-calling" ? "error" : current)
      }
    })
  }, [applySnapshot, closeStream])

  const startSession = useCallback(async (instruction: string, targetJigId?: string, images?: string[]): Promise<boolean> => {
    const previousSessionId = sessionIdRef.current
    if (previousSessionId && !options.persistOnUnmount) {
      await closeAgentSession(previousSessionId).catch(() => {})
      sessionIdRef.current = null
    }
    closeStream()

    setEvents([])
    setStatus("thinking")
    setJigId(null)
    setRequiredConnections([])
    setSuggestedConnections([])
    setMetrics(undefined)
    setDraftApproval(undefined)

    const nextConversation = [...conversation, { role: "user" as const, content: instruction.trim() }].filter((t) => t.content)
    setConversation(nextConversation)

    try {
      const data = await startAgentSession(instruction, targetJigId, nextConversation, images)
      setSessionId(data.sessionId)
      sessionIdRef.current = data.sessionId
      setJigId(data.jigId ?? null)
      subscribe(data.sessionId)
      return true
    } catch (e: any) {
      setStatus("error")
      setEvents([{ type: "text", content: e?.message ?? "Unknown error" }])
      setRequiredConnections(Array.isArray(e?.details?.requiredConnections) ? e.details.requiredConnections : [])
      setSuggestedConnections(extractSuggestedConnections(e))
      setMetrics(undefined)
      setDraftApproval(undefined)
      return false
    }
  }, [closeStream, conversation, options.persistOnUnmount, subscribe])

  const resumeSession = useCallback(async (sid: string): Promise<boolean> => {
    if (!sid || sessionIdRef.current === sid) return true
    closeStream()
    setEvents([])
    setStatus("thinking")
    setSessionId(sid)
    sessionIdRef.current = sid
    setJigId(null)
    setRequiredConnections([])
    setSuggestedConnections([])
    setMetrics(undefined)
    setDraftApproval(undefined)
    subscribe(sid)
    return true
  }, [closeStream, subscribe])

  const sendMessage = useCallback(async (message: string, images?: string[]): Promise<boolean> => {
    if (!sessionId) return false
    setStatus("thinking")
    const nextConversation = [...conversation, { role: "user" as const, content: message.trim() }].filter((t) => t.content)
    setConversation(nextConversation)
    try {
      await sendAgentMessage(sessionId, message, nextConversation, images)
      // SSE stream is already open; backend will emit new frames.
      if (!sourceRef.current) subscribe(sessionId)
      return true
    } catch (e: any) {
      setStatus("error")
      setEvents((prev) => prev.concat({ type: "text", content: e?.message ?? "Unknown error" }))
      return false
    }
  }, [conversation, sessionId, subscribe])

  const approveDraftFn = useCallback(async (): Promise<boolean> => {
    if (!sessionId) return false
    try {
      setStatus("thinking")
      await approveAgentDraft(sessionId)
      setDraftApproval(undefined)
      // Backend marks the session done; stream will emit the terminal frame.
      if (!sourceRef.current) subscribe(sessionId)
      return true
    } catch (e: any) {
      setStatus("error")
      setEvents((prev) => prev.concat({ type: "text", content: e?.message ?? "Unknown error" }))
      return false
    }
  }, [sessionId, subscribe])

  const reset = useCallback(async () => {
    const sid = sessionIdRef.current
    closeStream()
    setEvents([])
    setStatus("idle")
    setSessionId(null)
    sessionIdRef.current = null
    setJigId(null)
    setRequiredConnections([])
    setSuggestedConnections([])
    setMetrics(undefined)
    setDraftApproval(undefined)
    setConversation([])
    if (sid) await closeAgentSession(sid).catch(() => {})
  }, [closeStream])

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
    draftApproval,
    isActive,
    isWaiting,
    canSend,
    startSession,
    resumeSession,
    sendMessage,
    approveDraft: approveDraftFn,
    reset,
  }
}

"use client"

import { useEffect, useRef, useState } from "react"
import type { AgentEvent, AgentMetrics, AgentStatus } from "@shared/api"
import { AgentActivity } from "@/components/agent-activity"
import { Button } from "@/components/button"
import { ConnectionTag } from "@/components/connection-tag"

type MetricKey = "model" | "round" | "tool" | "estimated" | "total" | "split"

function formatCompactNumber(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}m`
  if (value >= 10_000) return `${Math.round(value / 1000)}k`
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`
  return value.toLocaleString()
}

function MetricChip({
  label,
  value,
  active = false,
  changed = false,
  mono = false,
}: {
  label?: string
  value: string
  active?: boolean
  changed?: boolean
  mono?: boolean
}) {
  return (
    <span
      data-active={active ? "true" : undefined}
      data-changed={changed ? "true" : undefined}
      className={`agent-metric-chip ${mono ? "font-mono" : ""}`}
    >
      {label && <span className="text-[#555]">{label}</span>}
      <span className="text-[#b7b7bd]">{value}</span>
    </span>
  )
}

function TokenMeter({
  prompt,
  completion,
  changed,
  active,
}: {
  prompt: number
  completion: number
  changed: boolean
  active: boolean
}) {
  const total = Math.max(prompt + completion, 1)
  const promptPct = Math.max(8, Math.min(92, (prompt / total) * 100))

  return (
    <span data-changed={changed ? "true" : undefined} className="agent-token-meter">
      <span className="flex items-center gap-1.5">
        <span>{formatCompactNumber(prompt)} in</span>
        <span className="text-[#3f3f46]">/</span>
        <span>{formatCompactNumber(completion)} out</span>
      </span>
      <span className="relative h-1 w-16 overflow-hidden rounded-full bg-[#252528]">
        <span
          className="absolute inset-y-0 left-0 rounded-full bg-emerald-400/70"
          style={{ width: `${promptPct}%` }}
        />
        <span
          className="absolute inset-y-0 right-0 rounded-full bg-blue-400/70"
          style={{ width: `${100 - promptPct}%` }}
        />
        {active && <span className="agent-token-sweep" />}
      </span>
    </span>
  )
}

function AgentMetricsStrip({ metrics, active }: { metrics: AgentMetrics; active: boolean }) {
  const [changedKeys, setChangedKeys] = useState<Set<MetricKey>>(new Set())
  const previousRef = useRef<AgentMetrics | undefined>(undefined)

  useEffect(() => {
    const previous = previousRef.current
    previousRef.current = metrics
    if (!previous) return

    const changed = new Set<MetricKey>()
    if (previous.model !== metrics.model) changed.add("model")
    if (previous.round !== metrics.round) changed.add("round")
    if (previous.activeTool !== metrics.activeTool) changed.add("tool")
    if (previous.estimatedPromptTokens !== metrics.estimatedPromptTokens) changed.add("estimated")
    if (previous.totalTokens !== metrics.totalTokens) changed.add("total")
    if (
      previous.promptTokens !== metrics.promptTokens ||
      previous.completionTokens !== metrics.completionTokens
    ) {
      changed.add("split")
    }

    if (changed.size === 0) return
    setChangedKeys(changed)
    const timer = setTimeout(() => setChangedKeys(new Set()), 850)
    return () => clearTimeout(timer)
  }, [metrics])

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 text-[10px] text-[#666]">
      {metrics.model && (
        <MetricChip value={metrics.model} mono changed={changedKeys.has("model")} />
      )}
      {metrics.round != null && (
        <MetricChip label="round" value={String(metrics.round)} changed={changedKeys.has("round")} />
      )}
      {metrics.activeTool && (
        <MetricChip
          label="tool"
          value={metrics.activeTool}
          mono
          active={active}
          changed={changedKeys.has("tool")}
        />
      )}
      {metrics.estimatedPromptTokens != null && metrics.promptTokens == null && (
        <MetricChip
          label="~"
          value={`${formatCompactNumber(metrics.estimatedPromptTokens)} in`}
          changed={changedKeys.has("estimated")}
        />
      )}
      {metrics.totalTokens != null && (
        <MetricChip
          value={`${formatCompactNumber(metrics.totalTokens)} tokens`}
          active={active}
          changed={changedKeys.has("total")}
        />
      )}
      {metrics.promptTokens != null && metrics.completionTokens != null && (
        <TokenMeter
          prompt={metrics.promptTokens}
          completion={metrics.completionTokens}
          changed={changedKeys.has("split")}
          active={active}
        />
      )}
    </div>
  )
}

export function AgentPanel({
  events,
  status,
  onRetry,
  requiredConnections = [],
  suggestedConnections = [],
  unknownConnections = [],
  metrics,
  onConnectionClick,
}: {
  events: AgentEvent[]
  status: AgentStatus
  onRetry?: () => void
  requiredConnections?: string[]
  suggestedConnections?: Array<{ name: string; connected: boolean; authRequired?: boolean }>
  unknownConnections?: string[]
  metrics?: AgentMetrics
  onConnectionClick?: (name: string) => void
}) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const missingKnown = suggestedConnections.filter((c) => !c.connected)
  const needsReconnect = suggestedConnections.filter((c) => c.authRequired)
  const showConnectionPanel =
    status === "error" && (suggestedConnections.length > 0 || unknownConnections.length > 0)
  // Retry helps after reconnecting auth or connecting a missing server.
  const showRetry =
    status === "error" &&
    !!onRetry &&
    (missingKnown.length > 0 || needsReconnect.length > 0 || !showConnectionPanel)

  const helperText = (() => {
    if (needsReconnect.length > 0) {
      return "A required connection's login expired. Reconnect it, then Retry."
    }
    if (unknownConnections.length > 0 && requiredConnections.length > 0) {
      return "Some required connections need setup, and some capabilities have no connector in jig yet. Connect the ones marked setup needed, or rewrite the prompt to use an available connection."
    }
    if (unknownConnections.length > 0) {
      return "This workflow needs capabilities jig doesn't have a connector for yet. Rewrite the prompt to use an available connection, or connect a different server that covers the task."
    }
    if (requiredConnections.length > 0) {
      return "These connections are needed. The ones marked setup needed are blocking — connect them, then Retry."
    }
    return "The planner suggested these connections for this jig. Open any one to inspect setup."
  })()

  // Auto-scroll to bottom when new events arrive so the latest
  // question/tool-call is always visible above the fold.
  useEffect(() => {
    const el = scrollRef.current
    if (!el) return
    el.scrollTop = el.scrollHeight
  }, [events.length, status])

  if (status === "idle") return null

  return (
    <div
      ref={scrollRef}
      className="border-t border-[#1f1f23] px-4 py-3 max-h-[320px] overflow-y-auto"
      style={{ animation: "fade-up 0.15s ease" }}
    >
      <div className="flex items-center justify-between mb-2">
        <span className="text-[10px] font-medium text-[#555] uppercase tracking-wider">Agent</span>
        {showRetry && (
          <Button onClick={onRetry} variant="subtle" size="xs">Retry</Button>
        )}
      </div>
      {metrics && <AgentMetricsStrip metrics={metrics} active={status === "thinking" || status === "tool-calling"} />}
      <AgentActivity events={events} status={status} activeStartedAt={metrics?.activeStartedAt} />
      {showConnectionPanel && (
        <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/[0.04] px-3 py-2">
          <p className="text-[10px] font-medium uppercase tracking-wider text-emerald-400">Suggested Connections</p>
          <p className="mt-1 text-[11px] leading-relaxed text-emerald-100/75">
            {helperText}
          </p>
          {(suggestedConnections.length > 0 || unknownConnections.length > 0) && (
            <div className="mt-2 flex flex-wrap gap-2">
              {suggestedConnections.map(({ name, connected, authRequired }) => (
                <ConnectionTag
                  key={name}
                  name={name}
                  detail={authRequired ? "reconnect needed" : connected ? "connected" : "setup needed"}
                  onClick={onConnectionClick}
                />
              ))}
              {unknownConnections.map((name) => (
                <ConnectionTag
                  key={`unknown:${name}`}
                  name={name}
                  detail="no connector"
                  interactive={false}
                />
              ))}
            </div>
          )}
          {(missingKnown.length > 0 || needsReconnect.length > 0) && (
            <div className="mt-2.5 flex flex-wrap gap-2">
              {missingKnown.map(({ name }) => (
                <Button key={name} onClick={() => onConnectionClick?.(name)} variant="success" size="xs">
                  Connect {name}
                </Button>
              ))}
              {needsReconnect.map(({ name }) => (
                <Button key={`reconnect:${name}`} onClick={() => onConnectionClick?.(name)} variant="success" size="xs">
                  Reconnect {name}
                </Button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

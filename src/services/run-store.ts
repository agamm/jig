import type { LiveRunStep, RunStatus } from "../../shared/api.js"
import type { RunEvent } from "../run-events.js"

type RunRecord = {
  runId: number
  jigId: string
  entity: string | null
  dryRun: boolean
  completedTools: string[]
  activeTools: string[]
  steps: LiveRunStep[]
  readOnly?: Record<string, boolean>
  error?: string
  output?: string
  done?: boolean
  finishedAt?: number
}

const RECENT_RESULT_TTL_MS = 60_000

let activeRunId: number | null = null
const runs = new Map<number, RunRecord>()
const recentResults = new Map<number, RunRecord>()

export function hasActiveRun(): boolean {
  return activeRunId !== null
}

export function getActiveRunId(): number | null {
  return activeRunId
}

export function startTrackedRun(runId: number, jigId: string, entity: string | null, dryRun: boolean): void {
  activeRunId = runId
  runs.set(runId, {
    runId,
    jigId,
    entity,
    dryRun,
    completedTools: [],
    activeTools: [],
    steps: [],
  })
}

export function applyRunEvent(runId: number, event: RunEvent): void {
  const run = runs.get(runId)
  if (!run) return

  if (event.type === "step-start") {
    run.steps.push({ seq: event.seq, label: event.label, status: "running" })
    return
  }

  if (event.type === "step-done") {
    const step = run.steps.find((s) => s.seq === event.seq)
    if (step) {
      step.status = event.status
      step.output = event.output
      step.connections = event.connections
      step.durationMs = event.durationMs
      step.error = event.error
    }
    return
  }

  if (event.type === "tool") {
    run.completedTools = event.completed
    run.activeTools = event.active
    if (event.readOnly) run.readOnly = event.readOnly
    return
  }

  if (event.type === "done") {
    run.done = true
    run.output = event.output
    run.activeTools = []
    return
  }

  if (event.type === "error") {
    run.done = true
    run.error = event.message
    run.activeTools = []
  }
}

export function finishTrackedRun(runId: number): void {
  const run = runs.get(runId)
  if (!run) return
  run.finishedAt = Date.now()
  recentResults.set(runId, run)
  runs.delete(runId)
  if (activeRunId === runId) activeRunId = null
  pruneRecentResults()
}

export function getRunStatus(runId: number): RunStatus | null {
  const run = runs.get(runId) ?? recentResults.get(runId)
  if (!run) return null
  return toRunStatus(run, runs.has(runId))
}

export function getActiveRunStatus(): RunStatus {
  pruneRecentResults()
  if (activeRunId !== null) {
    const run = runs.get(activeRunId)
    if (run) return toRunStatus(run, true)
  }

  const latest = [...recentResults.values()]
    .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]

  if (!latest) {
    return {
      active: false,
      completedTools: [],
      activeTools: [],
      steps: [],
    }
  }

  return toRunStatus(latest, false)
}

function toRunStatus(run: RunRecord, active: boolean): RunStatus {
  return {
    active,
    runId: run.runId,
    jigId: run.jigId,
    entity: run.entity,
    dryRun: run.dryRun,
    completedTools: run.completedTools,
    activeTools: run.activeTools,
    steps: run.steps,
    readOnly: run.readOnly,
    error: run.error,
    output: run.output,
    status: run.error ? "fail" : run.done ? "success" : "running",
  }
}

function pruneRecentResults(): void {
  const now = Date.now()
  for (const [runId, run] of recentResults) {
    if ((run.finishedAt ?? now) + RECENT_RESULT_TTL_MS < now) {
      recentResults.delete(runId)
    }
  }
}

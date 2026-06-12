import type { LiveRunStep, RunStatus } from "../../shared/api.js"
import type { RunEvent } from "../run-events.js"
import { isCancellationMessage, USER_CANCELLED_MESSAGE } from "../run-cancel.js"
import { broadcastJigsUpdated } from "../server/live-updates.js"
import { openDb } from "../db.js"

type RunRecord = {
  runId: number
  jigId: string
  dryRun: boolean
  startedAt: number
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

// Hard ceiling on a single run. A hung tool call or infinite loop would
// otherwise hold the per-jig "active run" slot forever — the scheduler skips
// jigs with an active run, so a single hang silently kills that schedule
// until restart. Overridable via JIG_RUN_TIMEOUT_MS.
const RUN_TIMEOUT_MS = (() => {
  const raw = Number(process.env.JIG_RUN_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30 * 60_000
})()

/** jigId → runId for currently executing runs */
const activeRuns = new Map<string, number>()
/** runId → AbortController for cancellation */
const activeAborts = new Map<number, AbortController>()
/** runId → RunRecord for in-flight runs */
const runs = new Map<number, RunRecord>()
/** runId → RunRecord for recently finished runs */
const recentResults = new Map<number, RunRecord>()
/** runId → timeout that aborts the run when it exceeds RUN_TIMEOUT_MS */
const runTimeouts = new Map<number, ReturnType<typeof setTimeout>>()
/** runId → timeout message, set when the watchdog fired for this run */
const timedOutRuns = new Map<number, string>()

function clearRunTimeout(runId: number): void {
  const timer = runTimeouts.get(runId)
  if (timer) clearTimeout(timer)
  runTimeouts.delete(runId)
}

function isDryRunLimitedOutput(output?: string): boolean {
  return typeof output === "string" && output.includes("[dry-run]")
}

export function hasActiveRunForJig(jigId: string): boolean {
  return activeRuns.has(jigId)
}


export function getActiveRunForJig(jigId: string): number | null {
  return activeRuns.get(jigId) ?? null
}

export function abortRunForJig(jigId: string): void {
  const runId = activeRuns.get(jigId)
  if (runId != null) activeAborts.get(runId)?.abort()
}

export function getSignalForRun(runId: number): AbortSignal | undefined {
  return activeAborts.get(runId)?.signal
}

export function startTrackedRun(runId: number, jigId: string, dryRun: boolean, timeoutMs?: number): void {
  activeRuns.set(jigId, runId)
  const controller = new AbortController()
  activeAborts.set(runId, controller)
  const runTimeoutMs = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : RUN_TIMEOUT_MS
  runTimeouts.set(runId, setTimeout(() => {
    // If the run already finished, finishTrackedRun has cleared this timer's
    // bookkeeping — bail so we don't relabel a completed run as timed-out at
    // the exact boundary (JS is single-threaded; an in-progress
    // finishTrackedRun can't interleave with this callback).
    if (!runs.has(runId)) return
    const message = `Run timed out after ${Math.round(runTimeoutMs / 60_000)} minutes`
    timedOutRuns.set(runId, message)
    console.error(`[runner] ${jigId} run ${runId}: ${message} — aborting`)
    controller.abort()
  }, runTimeoutMs))
  runs.set(runId, {
    runId,
    jigId,
    dryRun,
    startedAt: Date.now(),
    completedTools: [],
    activeTools: [],
    steps: [],
  })
  broadcastJigsUpdated("run-start")
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
      const dryRunLimited = run.dryRun && event.status === "fail" && isDryRunLimitedOutput(event.output)
      step.status = dryRunLimited ? "healed" : event.status
      step.output = dryRunLimited
        ? `${event.output}\n\n[dry-run] This preview stopped here because a later value depends on a skipped write tool. Use Run for a real execution.`
        : event.output
      step.connections = event.connections
      step.durationMs = event.durationMs
      step.error = dryRunLimited ? undefined : event.error
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
    if (run.dryRun && run.steps.some((step) => step.status === "healed" && isDryRunLimitedOutput(step.output))) {
      run.done = true
      run.activeTools = []
      return
    }
    const cancelled = isCancellationMessage(event.message)
    run.done = true
    run.error = cancelled ? USER_CANCELLED_MESSAGE : event.message
    if (cancelled) {
      run.output = USER_CANCELLED_MESSAGE
    }
    run.activeTools = []
  }
}

export function finishTrackedRun(runId: number): void {
  const run = runs.get(runId)
  if (!run) return
  clearRunTimeout(runId)

  // A timeout abort surfaces through the runner as a cancellation ("Run
  // cancelled"), which would be skipped by failure notifications and shown
  // as user-cancelled. Rewrite it to the real story — both in the live
  // record and the persisted row (which is final by the time we get here).
  const timeoutMessage = timedOutRuns.get(runId)
  if (timeoutMessage) {
    timedOutRuns.delete(runId)
    run.error = timeoutMessage
    run.output = undefined
    if (runId > 0) {
      try {
        openDb().prepare(`UPDATE runs SET status = 'fail', error = ?, output = NULL WHERE id = ?`)
          .run(timeoutMessage, runId)
      } catch (e: any) {
        console.error(`[runner] failed to persist timeout for run ${runId}: ${e?.message ?? e}`)
      }
    }
  }

  run.finishedAt = Date.now()
  recentResults.set(runId, run)
  runs.delete(runId)
  if (activeRuns.get(run.jigId) === runId) {
    activeRuns.delete(run.jigId)
  }
  activeAborts.delete(runId)
  pruneRecentResults()
  broadcastJigsUpdated("run-finish")
}

export function discardTrackedRun(runId: number): void {
  const run = runs.get(runId)
  if (!run) return
  clearRunTimeout(runId)
  timedOutRuns.delete(runId)
  runs.delete(runId)
  if (activeRuns.get(run.jigId) === runId) {
    activeRuns.delete(run.jigId)
  }
  activeAborts.delete(runId)
  broadcastJigsUpdated("run-discard")
}

export function clearTrackedRunsForJig(jigId: string): void {
  const activeRunId = activeRuns.get(jigId)
  if (activeRunId != null) {
    activeRuns.delete(jigId)
    activeAborts.delete(activeRunId)
    runs.delete(activeRunId)
    clearRunTimeout(activeRunId)
    timedOutRuns.delete(activeRunId)
  }

  for (const [runId, run] of recentResults) {
    if (run.jigId === jigId) recentResults.delete(runId)
  }
  broadcastJigsUpdated("run-clear")
}

export function getRunStatus(runId: number): RunStatus | null {
  const run = runs.get(runId) ?? recentResults.get(runId)
  if (!run) return null
  return toRunStatus(run, runs.has(runId))
}

export function getActiveRunStatus(): RunStatus {
  return getActiveRunStatusForJig()
}

export function getActiveRunStatusForJig(jigId?: string): RunStatus {
  pruneRecentResults()

  if (jigId) {
    const runId = activeRuns.get(jigId)
    const run = runId != null ? runs.get(runId) : null
    if (run) return toRunStatus(run, true)
    const latestForJig = [...recentResults.values()]
      .filter((recent) => recent.jigId === jigId)
      .sort((a, b) => (b.finishedAt ?? 0) - (a.finishedAt ?? 0))[0]
    if (latestForJig) return toRunStatus(latestForJig, false)
    return {
      active: false,
      jigId,
      completedTools: [],
      activeTools: [],
      steps: [],
    }
  }

  // Return the first active run (for dashboard polling)
  for (const runId of activeRuns.values()) {
    const run = runs.get(runId)
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
    dryRun: run.dryRun,
    startedAt: run.startedAt,
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

/** Clear all in-memory run state. Intended for tests only. */
export function resetRunStoreForTests(): void {
  activeRuns.clear()
  activeAborts.clear()
  runs.clear()
  recentResults.clear()
  for (const runId of runTimeouts.keys()) clearRunTimeout(runId)
  timedOutRuns.clear()
}

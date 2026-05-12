import type { CancelRunResponse, RunDetail, StartRunResponse } from "../../shared/api.js"
import { getRun, insertRun, openDb } from "../db.js"
import { runJig, persist } from "../runner.js"
import { formatDuration } from "../utils.js"
import { ApiError } from "../server/http.js"
import { abortRunForJig, applyRunEvent, discardTrackedRun, finishTrackedRun, getActiveRunStatusForJig, getSignalForRun, getRunStatus, hasActiveRunForJig, startTrackedRun } from "./run-store.js"
import { maybeNotifyRunFailure } from "./run-failure-notify.js"
import { missingConnectionsForJig } from "./connection-preflight.js"
import { materializeActiveVersion } from "./jig-runtime.js"
import { getJigRow } from "./jig-store.js"

/** Materialize the active version of a jig for the runner to import. */
async function resolveRunnablePath(jigId: string): Promise<string | null> {
  const materialized = await materializeActiveVersion(jigId)
  return materialized?.path ?? null
}

function assertConnectionsReady(jigPath: string): void {
  const missing = missingConnectionsForJig(jigPath)
  if (missing.length === 0) return

  throw new ApiError(
    400,
    missing.length === 1
      ? `Connection required: ${missing[0]}`
      : `Connections required: ${missing.join(", ")}`,
    {
      code: "missing_connections",
      requiredConnections: missing,
      connectionStatuses: missing.map((name) => ({ name, connected: false })),
    },
  )
}

export async function startJigRun(id: string, body: any): Promise<StartRunResponse> {
  if (!getJigRow(id)) throw new ApiError(404, `Jig not found: ${id}`)

  const dryRun = body?.dryRun === true
  const jigPath = await resolveRunnablePath(id)

  if (!jigPath) throw new ApiError(404, "Jig has no active version")
  assertConnectionsReady(jigPath)
  if (hasActiveRunForJig(id)) throw new ApiError(409, `A run is already in progress for ${id}`)

  const runId = dryRun ? -Date.now() : insertRun(id)
  startTrackedRun(runId, id, dryRun)

  const startTime = Date.now()
  const persistHandler = !dryRun ? persist(runId, startTime) : null

  ;(async () => {
    let skipped = false
    try {
      console.log(`[run] ${id} started (runId=${runId}${dryRun ? ", dryRun" : ""})`)
      const result = await runJig(jigPath, {}, (event) => {
        if (event.type !== "skipped") applyRunEvent(runId, event)
        if (event.type !== "skipped") persistHandler?.(event)
        // Mirror step failures + fatal errors to console.error so the Logs
        // page surfaces *why* a run failed (otherwise silent:true hides it).
        if (event.type === "step-done" && event.status === "fail") {
          console.error(`[run] ${id} step ${event.seq} failed: ${event.error ?? "(no error message)"}`)
        } else if (event.type === "error") {
          console.error(`[run] ${id} error: ${event.message}`)
        } else if (event.type === "done") {
          console.log(`[run] ${id} done in ${event.durationMs}ms`)
        }
      }, { dryRun, silent: true, signal: getSignalForRun(runId) })
      if (result.skipped && !dryRun) {
        skipped = true
        const db = openDb()
        db.prepare(`DELETE FROM run_steps WHERE run_id = ?`).run(runId)
        db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId)
      }
    } finally {
      if (skipped) discardTrackedRun(runId)
      else {
        finishTrackedRun(runId)
        void maybeNotifyRunFailure(id, runId, dryRun).catch(() => {})
      }
    }
  })()

  return { runId, jigId: id, dryRun }
}

export function getActiveRunSnapshot(jigId?: string) {
  return getActiveRunStatusForJig(jigId)
}

export function getRunDetail(runId: number): RunDetail {
  const status = getRunStatus(runId)
  const run = runId > 0 ? getRun(runId) : null

  if (!run && !status) throw new ApiError(404, `Run not found: ${runId}`)

  if (!run && status) {
    return {
      id: runId,
      jigId: status.jigId ?? "unknown",
      startedAt: null,
      finishedAt: null,
      status: status.status ?? "running",
      durationMs: null,
      error: status.error ?? null,
      completedTools: status.completedTools,
      activeTools: status.activeTools,
      readOnly: status.readOnly,
      output: status.output ?? null,
      steps: status.steps.map((step) => ({
        label: step.label,
        time: step.durationMs ? formatDuration(step.durationMs) : "—",
        status: step.status,
        output: step.output,
        error: step.error,
        healed: step.status === "healed",
        connections: step.connections,
      })),
    }
  }

  return {
    id: run!.id,
    jigId: run!.jig_id,
    startedAt: run!.started_at,
    finishedAt: run!.finished_at,
    status: status?.status ?? run!.status,
    durationMs: run!.duration_ms,
    error: status?.error ?? run!.error,
    completedTools: status?.completedTools ?? [],
    activeTools: status?.activeTools ?? [],
    readOnly: status?.readOnly,
    output: status?.output ?? run!.output ?? null,
    steps: (status?.steps?.length ? status.steps : run!.steps.map((step) => ({
      seq: step.seq,
      label: step.label,
      status: step.status,
      output: step.output ?? undefined,
      error: step.error ?? undefined,
      durationMs: step.duration_ms ?? undefined,
      connections: step.connections ? JSON.parse(step.connections) : [],
    }))).map((step) => ({
      label: step.label,
      time: step.durationMs ? formatDuration(step.durationMs) : "—",
      status: step.status,
      output: step.output,
      error: step.error,
      healed: step.status === "healed",
      connections: step.connections,
    })),
  }
}

export async function cancelActiveRun(jigId?: string): Promise<CancelRunResponse> {
  if (!jigId) {
    // Cancel the first active run (backward compat)
    const status = getActiveRunStatusForJig()
    if (!status.active || !status.jigId) throw new ApiError(404, "No run in progress")
    jigId = status.jigId
  }
  if (!hasActiveRunForJig(jigId)) throw new ApiError(404, `No run in progress for jig: ${jigId}`)
  abortRunForJig(jigId)
  return { ok: true, jigId }
}

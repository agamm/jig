import type { CancelRunResponse, RunDetail, StartRunResponse } from "../../shared/api.js"
import { getRun, insertRun } from "../db.js"
import { formatDuration } from "../utils.js"
import { ApiError } from "../server/http.js"
import { abortRunForJig, getActiveRunStatusForJig, getRunStatus, hasActiveRunForJig, startTrackedRun } from "./run-store.js"
import { executeRun, prepareRun } from "./run-core.js"

export async function startJigRun(id: string, body: any): Promise<StartRunResponse> {
  const prepared = await prepareRun(id)
  if (!prepared.ok) {
    if (prepared.reason === "not-found") throw new ApiError(404, `Jig not found: ${id}`)
    if (prepared.reason === "no-active-version") throw new ApiError(404, "Jig has no active version")
    throw new ApiError(400, prepared.message, {
      code: "missing_connections",
      requiredConnections: prepared.missing,
      connectionStatuses: prepared.missing.map((name) => ({ name, connected: false })),
    })
  }
  if (hasActiveRunForJig(id)) throw new ApiError(409, `A run is already in progress for ${id}`)

  const { jigPath } = prepared
  const dryRun = body?.dryRun === true
  const runId = dryRun ? -Date.now() : insertRun(id)
  startTrackedRun(runId, id, dryRun)

  console.log(`[run] ${id} started (runId=${runId}${dryRun ? ", dryRun" : ""})`)

  // Fire and forget: the dashboard follows progress over the run-status API.
  void executeRun({
    jigId: id,
    runId,
    jigPath,
    dryRun,
    logPrefix: "run",
  }).catch(() => {})

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

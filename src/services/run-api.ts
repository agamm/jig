import type { RunDetail, StartRunResponse } from "../../shared/api.js"
import { PROJECT_ROOT } from "../config/paths.js"
import { insertRun, getRun } from "../db.js"
import { discoverAllJigs } from "./jig-api.js"
import { runJig, persist } from "../runner.js"
import { formatDuration } from "../utils.js"
import { ApiError } from "../server/http.js"
import { abortActiveRun, applyRunEvent, finishTrackedRun, getActiveRunId, getActiveRunStatus, getActiveSignal, getRunStatus, hasActiveRun, startTrackedRun } from "./run-store.js"
import { resolveJigPath } from "../domain/jig-source.js"
import { existsSync } from "fs"

export async function startJigRun(id: string, body: any): Promise<StartRunResponse> {
  const discovered = discoverAllJigs()
  if (!discovered.has(id)) throw new ApiError(404, `Jig not found: ${id}`)

  const params = (body?.params ?? {}) as Record<string, string>
  const dryRun = body?.dryRun === true
  const jigPath = resolveJigPath(id)

  if (!existsSync(jigPath)) throw new ApiError(404, "Jig file not found")
  if (!existsSync(`${PROJECT_ROOT}/.jig/connections/index.ts`)) {
    throw new ApiError(400, "No connections found. Run 'jig connect <server>' first.")
  }
  if (hasActiveRun()) throw new ApiError(409, "A run is already in progress")

  const runId = dryRun ? -Date.now() : insertRun(id, Object.keys(params).length > 0 ? params : undefined)
  startTrackedRun(runId, id, dryRun)

  const startTime = Date.now()
  const persistHandler = !dryRun ? persist(runId, startTime) : null

  ;(async () => {
    try {
      await runJig(jigPath, params, (event) => {
        applyRunEvent(runId, event)
        persistHandler?.(event)
      }, { dryRun, silent: true, signal: getActiveSignal() })
    } finally {
      finishTrackedRun(runId)
    }
  })()

  return { runId, jigId: id, dryRun }
}

export function getActiveRunSnapshot() {
  return getActiveRunStatus()
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

export async function cancelActiveRun(): Promise<{ ok: true; runId: number }> {
  const runId = getActiveRunId()
  if (runId === null) throw new ApiError(404, "No run in progress")
  abortActiveRun()
  return { ok: true, runId }
}

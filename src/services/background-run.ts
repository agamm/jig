/**
 * Starts a background run for a jig — shared between cron tick and webhook
 * triggers. Adds schedule bookkeeping around the shared run core; the run
 * itself is identical to the one the dashboard starts.
 */
import { completeRun, insertRun, markScheduleTriggered, setScheduleError } from "../db.js"
import { hasActiveRunForJig, startTrackedRun } from "./run-store.js"
import { maybeNotifyRunFailure } from "./run-failure-notify.js"
import { executeRun, prepareRun } from "./run-core.js"

export async function startBackgroundRun(jigId: string, params?: Record<string, unknown>): Promise<boolean> {
  if (hasActiveRunForJig(jigId)) return false

  const prepared = await prepareRun(jigId)
  if (!prepared.ok) {
    if (prepared.reason === "not-found" || prepared.reason === "no-active-version") {
      setScheduleError(jigId, "Jig has no active version")
      return false
    }
    // Record the preflight failure as a failed run so it is visible in history
    // rather than only in the schedule row.
    const runId = insertRun(jigId, params)
    markScheduleTriggered(jigId, Math.floor(Date.now() / 1000))
    completeRun(runId, "fail", 0, prepared.message)
    setScheduleError(jigId, prepared.message)
    console.error(`[scheduler] ${jigId} failed preflight: ${prepared.message}`)
    void maybeNotifyRunFailure(jigId, runId, false).catch(() => {})
    return false
  }

  const { jigPath, jigRow } = prepared
  const runId = insertRun(jigId, params)
  startTrackedRun(runId, jigId, false, jigRow.run_timeout_ms ?? undefined)
  markScheduleTriggered(jigId, Math.floor(Date.now() / 1000))

  try {
    await executeRun({
      jigId,
      runId,
      jigPath,
      params,
      logPrefix: "scheduler",
      toolTimeoutMs: jigRow.tool_timeout_ms ?? null,
    })
  } catch (e: any) {
    setScheduleError(jigId, e?.message ?? String(e))
    console.error(`[scheduler] ${jigId} failed: ${e?.message ?? e}`)
  }
  return true
}

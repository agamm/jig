/**
 * Starts a background run for a jig — shared between cron tick and webhook triggers.
 *
 * Mirrors startJigRun() in run-api.ts but without HTTP request/response wrapping.
 */
import { completeRun, insertRun, markScheduleTriggered, openDb, setScheduleError } from "../db.js"
import { runJig, persist } from "../runner.js"
import { applyRunEvent, discardTrackedRun, finishTrackedRun, getSignalForRun, hasActiveRunForJig, startTrackedRun } from "./run-store.js"
import { maybeNotifyRunFailure } from "./run-failure-notify.js"
import { missingConnectionsForJig } from "./connection-preflight.js"
import { materializeActiveVersion } from "./jig-runtime.js"
import { getJigRow } from "./jig-store.js"

async function resolveRunnablePath(jigId: string): Promise<string | null> {
  const materialized = await materializeActiveVersion(jigId)
  return materialized?.path ?? null
}

function missingConnectionsMessage(missingConnections: string[]): string {
  return missingConnections.length === 1
    ? `Connection required: ${missingConnections[0]}`
    : `Connections required: ${missingConnections.join(", ")}`
}

export async function startBackgroundRun(jigId: string, params?: Record<string, unknown>): Promise<boolean> {
  if (hasActiveRunForJig(jigId)) return false

  const jigPath = await resolveRunnablePath(jigId)
  if (!jigPath) {
    setScheduleError(jigId, "Jig has no active version")
    return false
  }
  const missingConnections = missingConnectionsForJig(jigPath)
  if (missingConnections.length > 0) {
    const error = missingConnectionsMessage(missingConnections)
    const runId = insertRun(jigId, params)
    markScheduleTriggered(jigId, Math.floor(Date.now() / 1000))
    completeRun(runId, "fail", 0, error)
    setScheduleError(jigId, error)
    console.error(`[scheduler] ${jigId} failed preflight: ${error}`)
    void maybeNotifyRunFailure(jigId, runId, false).catch(() => {})
    return false
  }

  const jigRow = getJigRow(jigId)
  const runId = insertRun(jigId, params)
  startTrackedRun(runId, jigId, false, jigRow?.run_timeout_ms ?? undefined)
  let shouldFinishTrackedRun = true

  const startTime = Date.now()
  markScheduleTriggered(jigId, Math.floor(startTime / 1000))
  const persistHandler = persist(runId, startTime)

  try {
    const result = await runJig(jigPath, params ?? {}, (event) => {
      // Don't persist "skipped" events — persist() doesn't handle them,
      // and we'll clean up the run row after
      if (event.type !== "skipped") {
        applyRunEvent(runId, event)
        persistHandler(event)
      }
      if (event.type === "step-done" && event.status === "fail") {
        console.error(`[scheduler] ${jigId} step ${event.seq} failed: ${event.error ?? "(no error message)"}`)
      } else if (event.type === "error") {
        console.error(`[scheduler] ${jigId} error: ${event.message}`)
      } else if (event.type === "done") {
        console.log(`[scheduler] ${jigId} done in ${event.durationMs}ms`)
      }
    }, { silent: true, signal: getSignalForRun(runId), toolTimeoutMs: jigRow?.tool_timeout_ms ?? null })

    // If skipped, remove the run row — it never happened
    if (result.skipped) {
      const db = openDb()
      db.prepare(`DELETE FROM run_steps WHERE run_id = ?`).run(runId)
      db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId)
      shouldFinishTrackedRun = false
      discardTrackedRun(runId)
    }
    return true
  } catch (e: any) {
    setScheduleError(jigId, e?.message ?? String(e))
    console.error(`[scheduler] ${jigId} failed: ${e?.message ?? e}`)
    completeRun(runId, "fail", Date.now() - startTime, e?.message ?? String(e))
  } finally {
    if (shouldFinishTrackedRun) {
      finishTrackedRun(runId)
      void maybeNotifyRunFailure(jigId, runId, false).catch(() => {})
    }
  }
  return true
}

/**
 * Starts a background run for a jig — shared between cron tick and webhook triggers.
 *
 * Mirrors startJigRun() in run-api.ts but without HTTP request/response wrapping.
 */
import { existsSync } from "fs"
import { PROJECT_ROOT } from "../config/paths.js"
import { completeRun, insertRun, markScheduleTriggered, openDb, setScheduleError } from "../db.js"
import { resolveJigPath } from "../domain/jig-source.js"
import { runJig, persist } from "../runner.js"
import { applyRunEvent, discardTrackedRun, finishTrackedRun, getSignalForRun, hasActiveRunForJig, startTrackedRun } from "./run-store.js"
import { maybeNotifyRunFailure } from "./run-failure-notify.js"

export async function startBackgroundRun(jigId: string, params?: Record<string, unknown>): Promise<boolean> {
  if (hasActiveRunForJig(jigId)) return false

  const jigPath = resolveJigPath(jigId)
  if (!existsSync(jigPath)) {
    setScheduleError(jigId, "Jig file not found")
    return false
  }
  if (!existsSync(`${PROJECT_ROOT}/.jig/connections/index.ts`)) {
    setScheduleError(jigId, "No connections found. Run 'jig connect <server>' first.")
    return false
  }

  const runId = insertRun(jigId, params)
  startTrackedRun(runId, jigId, false)
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
    }, { silent: true, signal: getSignalForRun(runId) })

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
    completeRun(runId, "fail", Date.now() - startTime, e?.message ?? String(e))
  } finally {
    if (shouldFinishTrackedRun) {
      finishTrackedRun(runId)
      void maybeNotifyRunFailure(jigId, runId, false).catch(() => {})
    }
  }
  return true
}

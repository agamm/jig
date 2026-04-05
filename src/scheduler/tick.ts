/**
 * Scheduler tick — fires due cron runs every 60 seconds.
 */
import { advanceSchedule, listDueSchedules, setScheduleError } from "../db.js"
import { hasActiveRunForJig } from "../services/run-store.js"
import { startBackgroundRun } from "../services/background-run.js"
import { computeNextRun } from "./cron-utils.js"

export function tick(): void {
  const now = Math.floor(Date.now() / 1000)
  const due = listDueSchedules(now)

  for (const schedule of due) {
    if (hasActiveRunForJig(schedule.jig_id)) continue
    if (!schedule.cron_expr) continue

    const nextRunAt = computeNextRun(schedule.cron_expr)
    if (nextRunAt == null) {
      setScheduleError(schedule.jig_id, `Invalid cron expression: ${schedule.cron_expr}`)
      continue
    }
    if (!advanceSchedule(schedule.jig_id, schedule.next_run_at, nextRunAt)) continue

    // Fire-and-forget — don't await, don't block the tick loop
    startBackgroundRun(schedule.jig_id).catch((e) => {
      console.error(`[scheduler] failed to start ${schedule.jig_id}:`, e?.message ?? e)
    })
  }
}

/**
 * Recovery — runs once at startup to handle missed runs and interrupted state.
 */
import { advanceSchedule, listAllSchedules, markInterruptedRuns, setScheduleError } from "../db.js"
import { startScheduledRun } from "../services/scheduled-run.js"
import { computeNextRun } from "./cron-utils.js"

export function recoverMissedRuns(): void {
  // Mark any runs stuck in "running" state as failed
  const interrupted = markInterruptedRuns()
  if (interrupted > 0) {
    console.log(`[scheduler] marked ${interrupted} interrupted run(s) as failed`)
  }

  const now = Math.floor(Date.now() / 1000)
  const schedules = listAllSchedules()

  for (const schedule of schedules) {
    if (schedule.trigger_type !== "cron") continue
    if (!schedule.enabled) continue
    if (!schedule.cron_expr) continue
    if (schedule.next_run_at == null || schedule.next_run_at > now) continue

    // This schedule was missed (next_run_at is in the past)
    const nextRunAt = computeNextRun(schedule.cron_expr)
    if (nextRunAt == null) {
      setScheduleError(schedule.jig_id, `Invalid cron expression: ${schedule.cron_expr}`)
      continue
    }

    if (schedule.missed_strategy === "catch-up") {
      // Fire once immediately, then advance to next future occurrence
      if (!advanceSchedule(schedule.jig_id, schedule.next_run_at, nextRunAt)) continue
      startScheduledRun(schedule.jig_id).catch((e) => {
        console.error(`[scheduler] catch-up failed for ${schedule.jig_id}:`, e?.message ?? e)
      })
    } else {
      // Skip — just advance to next future occurrence
      advanceSchedule(schedule.jig_id, schedule.next_run_at, nextRunAt)
    }
  }
}

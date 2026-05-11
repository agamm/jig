/**
 * Schedule sync — reconciles jig trigger configs with the schedules table.
 *
 * On startup and periodically, reads each jig source file to reconcile the
 * schedules table without executing jig module side effects.
 */
import { readFileSync } from "fs"
import { JIGS_DIR } from "../config/paths.js"
import { discoverJigs } from "../discover.js"
import { extractTriggerConfig, resolveJigPath } from "../domain/jig-source.js"
import { deleteSchedule, getSchedule, listAllSchedules, setScheduleError, upsertSchedule } from "../db.js"
import { schedulerTimeZone } from "../config/timezone.js"
import { computeNextRun } from "./cron-utils.js"

function readTriggerConfig(jigId: string) {
  const jigPath = resolveJigPath(jigId)
  try {
    return extractTriggerConfig(readFileSync(jigPath, "utf-8"))
  } catch (error: any) {
    return {
      trigger: null,
      error: `Failed to read jig source: ${error?.message ?? String(error)}`,
    }
  }
}

export async function syncSchedules(): Promise<void> {
  const jigs = discoverJigs(JIGS_DIR)
  const activeJigIds = new Set(jigs.keys())

  // Reconcile each discovered jig
  for (const jigId of activeJigIds) {
    const existing = getSchedule(jigId)
    const { trigger, error } = readTriggerConfig(jigId)

    if (error) {
      if (existing) setScheduleError(jigId, error)
      continue
    }

    if (!trigger || trigger.type === "manual") {
      deleteSchedule(jigId)
      continue
    }

    if (trigger.type === "cron" && trigger.cron) {
      const cronExpr = trigger.cron
      const missedStrategy = trigger.missedStrategy ?? "catch-up"
      const timezone = schedulerTimeZone()

      // Only recompute next_run_at when the schedule definition changed. This
      // preserves already-due runs during regular sync, while migrating old UTC
      // schedules once because their stored timezone is null.
      const cronChanged = !existing || existing.cron_expr !== cronExpr
      const timezoneChanged = !existing || existing.timezone !== timezone
      const computedNextRunAt = cronChanged || timezoneChanged ? computeNextRun(cronExpr, timezone) : existing.next_run_at
      const nextRunAt = computedNextRunAt ?? existing?.next_run_at ?? null
      const syncError = computedNextRunAt === null ? `Invalid cron expression: ${cronExpr}` : null

      upsertSchedule(jigId, "cron", cronExpr, missedStrategy, nextRunAt, syncError, timezone)
      continue
    }

    if (trigger.type === "webhook") {
      upsertSchedule(jigId, "webhook", null, "skip", null, null)
      continue
    }

    if (existing) setScheduleError(jigId, `Unsupported trigger type: ${trigger.type}`)
  }

  // Remove schedules for deleted jigs
  const allSchedules = listAllSchedules()
  for (const schedule of allSchedules) {
    if (!activeJigIds.has(schedule.jig_id)) {
      deleteSchedule(schedule.jig_id)
    }
  }
}

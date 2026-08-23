/**
 * Scheduler tick — fires due cron runs every 60 seconds.
 */
import { advanceSchedule, getSchedule, listAllSchedules, listCalendarFires, listDueJigReminders, listDueSchedules, markJigRemindersFired, pruneCalendarFires, recordCalendarFire, setScheduleError } from "../db.js"
import { hasActiveRunForJig } from "../services/run-store.js"
import { startBackgroundRun } from "../services/background-run.js"
import { computeNextRun } from "./cron-utils.js"
import { calendarTick } from "./calendar-tick.js"
import { reminderTick } from "./reminder-tick.js"
import { CALENDAR_SERVER, CALENDAR_TOOL, mapCalendarEvents, upcomingEventsArgs } from "./calendar-source.js"
import { extractTriggerConfig } from "../domain/jig-source.js"
import { getActiveCode } from "../services/jig-store.js"
import { callServerTool } from "../mcp/call-server-tool.js"

/** How far ahead to look. Comfortably past the 1440-minute maximum lead time. */
const CALENDAR_HORIZON_MS = 36 * 60 * 60 * 1000
/** Nearest N events; the tick runs every minute, so later ones arrive in time. */
const CALENDAR_MAX_EVENTS = 10
const FIRE_LEDGER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000

export function tick(): void {
  const now = Math.floor(Date.now() / 1000)
  const due = listDueSchedules(now)

  for (const schedule of due) {
    if (hasActiveRunForJig(schedule.jig_id)) continue
    if (!schedule.cron_expr) continue

    const nextRunAt = computeNextRun(schedule.cron_expr, schedule.timezone ?? undefined)
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

  // Calendar triggers are polled on the same minute tick but off the cron path:
  // their next fire time comes from the calendar, not from an expression.
  void runCalendarPass().catch((e) => {
    console.error(`[scheduler] calendar pass failed:`, (e as Error)?.message ?? e)
  })

  // Reminders are likewise off the cron path, a jig sets its own wake-up time
  // with ctx.remind, so there is no expression to advance. They fire for any
  // trigger type, including manual jigs, which have no schedule row at all.
  void runReminderPass().catch((e) => {
    console.error(`[scheduler] reminder pass failed:`, (e as Error)?.message ?? e)
  })
}

async function runReminderPass(): Promise<void> {
  await reminderTick({
    now: () => Date.now(),
    listDue: listDueJigReminders,
    // A jig with no schedule row is manual-triggered, not disabled, reminders
    // are the only thing that ever wakes those, so they must not be gated out.
    isEnabled: (jigId) => getSchedule(jigId)?.enabled !== 0,
    isRunning: hasActiveRunForJig,
    markFired: markJigRemindersFired,
    startRun: (jigId, params) => startBackgroundRun(jigId, params),
    onError: (jigId, error) => {
      const message = (error as Error)?.message ?? String(error)
      console.error(`[scheduler] reminder run failed for ${jigId}: ${message}`)
    },
  })
}

async function runCalendarPass(): Promise<void> {
  const jigIds = listAllSchedules()
    .filter((s) => s.trigger_type === "calendar" && s.enabled)
    .map((s) => s.jig_id)
  if (jigIds.length === 0) return

  await calendarTick(jigIds, {
    now: () => Date.now(),
    // Read from the jig source rather than a schedules column: the source is
    // already the trigger's source of truth and sync re-reads it every cycle.
    leadMinutesFor: (jigId) => {
      const code = getActiveCode(jigId)
      if (code == null) return null
      const { trigger } = extractTriggerConfig(code)
      return trigger?.type === "calendar" ? trigger.minutesBefore ?? null : null
    },
    fetchEvents: async (_jigId, now) => mapCalendarEvents(
      await callServerTool(CALENDAR_SERVER, CALENDAR_TOOL, upcomingEventsArgs(now, CALENDAR_HORIZON_MS, CALENDAR_MAX_EVENTS)),
    ),
    alreadyFired: listCalendarFires,
    recordFire: recordCalendarFire,
    isRunning: hasActiveRunForJig,
    startRun: (jigId, params) => startBackgroundRun(jigId, params),
    onError: (jigId, error) => {
      const message = (error as Error)?.message ?? String(error)
      console.error(`[scheduler] calendar lookup failed for ${jigId}: ${message}`)
      setScheduleError(jigId, `Calendar lookup failed: ${message}`)
    },
  })

  pruneCalendarFires(Date.now() - FIRE_LEDGER_RETENTION_MS)
}

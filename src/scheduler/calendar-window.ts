/**
 * Which upcoming calendar events are due to fire a jig right now.
 *
 * Kept as one pure function on purpose: the calendar source, the persistence of
 * what already fired, and the run-starting all live outside, so the part with
 * the actual edge cases (late ticks, restarts, repeats) is testable without a
 * calendar, a clock, or a database.
 *
 * This replaces the pattern a polling jig has to invent for itself: ask every N
 * minutes, then use an N-minute-wide window to avoid acting twice on the same
 * meeting. That couples the window to the cron interval, so changing either one
 * silently double-fires or drops meetings. Dedup belongs on the event id.
 */

export interface CalendarEvent {
  id: string
  title: string
  /** Event start, epoch ms. */
  startsAt: number
  attendees?: string[]
}

export interface DueCalendarOptions {
  events: CalendarEvent[]
  /** Lead time: fire this many minutes before the event starts. 0 fires at start. */
  minutesBefore: number
  now: number
  /** Event ids this jig has already fired for. */
  alreadyFired: ReadonlySet<string>
}

/**
 * How late a fire is still worth doing. A tick missed because the process was
 * restarting should still send the briefing; one missed because the machine was
 * off all morning should not, since the meeting is already underway.
 */
const STALE_GRACE_MS = 5 * 60_000

export function dueCalendarEvents(opts: DueCalendarOptions): CalendarEvent[] {
  const leadMs = Math.max(0, opts.minutesBefore) * 60_000

  return opts.events
    .filter((event) => {
      if (!Number.isFinite(event.startsAt)) return false
      if (opts.alreadyFired.has(event.id)) return false
      const fireAt = event.startsAt - leadMs
      return opts.now >= fireAt && opts.now < event.startsAt + STALE_GRACE_MS
    })
    .sort((a, b) => a.startsAt - b.startsAt)
}

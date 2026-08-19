/**
 * The calendar half of the scheduler tick.
 *
 * Every dependency is injected: the calendar, the dedup ledger, the clock, and
 * run-starting. The interesting behaviour (what fires, in what order, what
 * happens when one jig's calendar is down) is then testable without a network,
 * a database, or waiting for a real minute to pass.
 */
import { dueCalendarEvents, type CalendarEvent } from "./calendar-window.js"

export interface CalendarTickDeps {
  now: () => number
  /** Lead time from the jig's declared trigger; null if it is no longer a calendar jig. */
  leadMinutesFor: (jigId: string) => number | null
  fetchEvents: (jigId: string, now: number) => Promise<CalendarEvent[]>
  alreadyFired: (jigId: string, sinceMs: number) => Set<string>
  recordFire: (jigId: string, eventId: string, firedAt: number) => void
  isRunning: (jigId: string) => boolean
  startRun: (jigId: string, params: Record<string, unknown>) => Promise<unknown>
  onError: (jigId: string, error: unknown) => void
}

/**
 * How far back the dedup ledger is consulted. Comfortably longer than any lead
 * time so a fired event stays suppressed for its whole window, and short enough
 * that the ledger stays small.
 */
const FIRE_MEMORY_MS = 48 * 60 * 60 * 1000

export async function calendarTick(jigIds: string[], deps: CalendarTickDeps): Promise<number> {
  const now = deps.now()
  let fired = 0

  for (const jigId of jigIds) {
    const minutesBefore = deps.leadMinutesFor(jigId)
    if (minutesBefore === null) continue
    // A run already in flight owns the jig; firing a second would race it.
    if (deps.isRunning(jigId)) continue

    try {
      const events = await deps.fetchEvents(jigId, now)
      const due = dueCalendarEvents({
        events,
        minutesBefore,
        now,
        alreadyFired: deps.alreadyFired(jigId, now - FIRE_MEMORY_MS),
      })

      for (const event of due) {
        // Record first. If the process dies between the two, record-first costs
        // one missed briefing; record-after would resend the same briefing on
        // every tick until one succeeded.
        deps.recordFire(jigId, event.id, now)
        await deps.startRun(jigId, {
          event_id: event.id,
          title: event.title,
          starts_at: new Date(event.startsAt).toISOString(),
          attendees: event.attendees ?? [],
          minutes_until_start: Math.round((event.startsAt - now) / 60_000),
        })
        fired++
      }
    } catch (error) {
      // One jig's calendar being unreachable must not stop the others.
      deps.onError(jigId, error)
    }
  }

  return fired
}

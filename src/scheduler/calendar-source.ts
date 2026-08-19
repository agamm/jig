/**
 * Where a calendar trigger's events come from: Google Calendar over composio.
 *
 * The shape below is not guessed. It came from
 *   jig debug eval composio googlecalendar_events_list --args='{"max_results":3}'
 * against a live connection: a Google list response, composio's envelope already
 * unwrapped, with events under `items` and each start as
 * `{ dateTime, timeZone }` (or `{ date }` for an all-day event).
 *
 * Mapping is split from fetching so the parts that actually go wrong (all-day
 * events, unparseable starts, a changed response shape) are testable without a
 * calendar or a network.
 */
import type { CalendarEvent } from "./calendar-window.js"

/** The tool this trigger is built on, and the connection it implies. */
export const CALENDAR_TOOL = "googlecalendar_events_list"
export const CALENDAR_SERVER = "composio"

interface RawCalendarEvent {
  id?: unknown
  summary?: unknown
  start?: { dateTime?: unknown; date?: unknown } | null
  attendees?: Array<{ email?: unknown }> | null
}

export function mapCalendarEvents(raw: unknown): CalendarEvent[] {
  const items = (raw as { items?: unknown } | null)?.items
  if (!Array.isArray(items)) {
    // Never fall back to []: a changed response shape would otherwise look like
    // an empty calendar, and every tick would report success while firing
    // nothing (SKILL.md rule 10).
    throw new Error(
      `${CALENDAR_SERVER}.${CALENDAR_TOOL} returned no "items" array. `
      + `Got: ${JSON.stringify(raw)?.slice(0, 300)}`,
    )
  }

  const events: CalendarEvent[] = []
  for (const item of items as RawCalendarEvent[]) {
    if (typeof item?.id !== "string" || !item.id) continue // dedup keys on id
    // An all-day event has start.date and no dateTime. A lead time is
    // meaningless for one, and reading the date as midnight would fire the
    // briefing late the previous evening.
    const dateTime = item.start?.dateTime
    if (typeof dateTime !== "string") continue
    const startsAt = Date.parse(dateTime)
    if (!Number.isFinite(startsAt)) continue

    events.push({
      id: item.id,
      title: typeof item.summary === "string" && item.summary ? item.summary : "(untitled event)",
      startsAt,
      attendees: (item.attendees ?? [])
        .map((a) => a?.email)
        .filter((e): e is string => typeof e === "string"),
    })
  }
  return events
}

/** Arguments for one upcoming-events lookup. Named exactly as the tool wants
 * them, confirmed by probing: camelCase timeMin/timeMax, snake_case max_results. */
export function upcomingEventsArgs(now: number, horizonMs: number, maxResults: number): Record<string, unknown> {
  return {
    timeMin: new Date(now).toISOString(),
    timeMax: new Date(now + horizonMs).toISOString(),
    // Expand recurring series into individual occurrences, so a weekly meeting
    // has one id per instance rather than one id for the whole series, which
    // dedup would then fire on exactly once forever.
    singleEvents: true,
    orderBy: "startTime",
    max_results: maxResults,
  }
}

import { describe, expect, it } from "bun:test"
import { mapCalendarEvents } from "../src/scheduler/calendar-source.js"

const event = (over: Record<string, unknown> = {}) => ({
  id: "abc123",
  summary: "Sync Up",
  start: { dateTime: "2026-08-19T15:00:00-05:00", timeZone: "America/Chicago" },
  attendees: [{ email: "a@example.com" }, { email: "b@example.com" }],
  ...over,
})

describe("mapCalendarEvents", () => {
  it("reads events out of the items key", () => {
    const out = mapCalendarEvents({ items: [event()] })
    expect(out).toHaveLength(1)
    expect(out[0].id).toBe("abc123")
    expect(out[0].title).toBe("Sync Up")
    expect(out[0].startsAt).toBe(Date.parse("2026-08-19T15:00:00-05:00"))
    expect(out[0].attendees).toEqual(["a@example.com", "b@example.com"])
  })

  // An all-day event carries start.date, not start.dateTime. "45 minutes before"
  // is meaningless for one, and treating the date as midnight would fire a
  // briefing at 11:15pm the night before.
  it("skips all-day events", () => {
    expect(mapCalendarEvents({ items: [event({ start: { date: "2026-08-19" } })] })).toEqual([])
  })

  it("skips events whose start will not parse", () => {
    expect(mapCalendarEvents({ items: [event({ start: { dateTime: "not a date" } })] })).toEqual([])
  })

  it("skips events with no id, since dedup keys on it", () => {
    expect(mapCalendarEvents({ items: [event({ id: undefined })] })).toEqual([])
  })

  it("falls back to a placeholder title rather than dropping the event", () => {
    expect(mapCalendarEvents({ items: [event({ summary: undefined })] })[0].title).toBe("(untitled event)")
  })

  it("tolerates an event with no attendees", () => {
    expect(mapCalendarEvents({ items: [event({ attendees: undefined })] })[0].attendees).toEqual([])
  })

  // Rule 10: never silently collapse an unexpected shape to [], or every
  // downstream tick starves on empty data while reporting success.
  it("throws when the response has no items key at all", () => {
    expect(() => mapCalendarEvents({ results: [] })).toThrow(/items/)
    expect(() => mapCalendarEvents("some prose")).toThrow(/items/)
  })

  it("accepts a genuinely empty calendar", () => {
    expect(mapCalendarEvents({ items: [] })).toEqual([])
  })
})

import { describe, expect, it } from "bun:test"
import { dueCalendarEvents, type CalendarEvent } from "../src/scheduler/calendar-window.js"

const MIN = 60_000
const at = (ms: number): CalendarEvent => ({ id: `e${ms}`, title: "Sync", startsAt: ms })
const none = new Set<string>()

describe("dueCalendarEvents", () => {
  const now = 1_000 * MIN

  it("fires once the lead time is reached", () => {
    const event = at(now + 45 * MIN)
    expect(dueCalendarEvents({ events: [event], minutesBefore: 45, now, alreadyFired: none }))
      .toEqual([event])
  })

  it("stays quiet while the event is still beyond the lead time", () => {
    expect(dueCalendarEvents({ events: [at(now + 46 * MIN)], minutesBefore: 45, now, alreadyFired: none }))
      .toEqual([])
  })

  // Replaces meeting-docket-report's 45-to-60-minute window, which was a dedup
  // mechanism disguised as a query: the window was 15 minutes wide only because
  // the cron was, so any change to either silently double-fired or missed.
  it("never fires twice for the same event", () => {
    const event = at(now + 30 * MIN)
    const fired = new Set([event.id])
    expect(dueCalendarEvents({ events: [event], minutesBefore: 45, now, alreadyFired: fired }))
      .toEqual([])
  })

  it("still fires late, so a scheduler restart does not lose the run", () => {
    const event = at(now + 2 * MIN)
    expect(dueCalendarEvents({ events: [event], minutesBefore: 45, now, alreadyFired: none }))
      .toEqual([event])
  })

  it("gives up once the event is well underway", () => {
    expect(dueCalendarEvents({ events: [at(now - 10 * MIN)], minutesBefore: 45, now, alreadyFired: none }))
      .toEqual([])
  })

  it("supports minutesBefore 0 as fire-at-start", () => {
    const event = at(now)
    expect(dueCalendarEvents({ events: [event], minutesBefore: 0, now, alreadyFired: none }))
      .toEqual([event])
  })

  it("returns soonest first so output order is deterministic", () => {
    const later = at(now + 40 * MIN)
    const sooner = at(now + 10 * MIN)
    expect(dueCalendarEvents({ events: [later, sooner], minutesBefore: 45, now, alreadyFired: none }))
      .toEqual([sooner, later])
  })

  it("ignores events with an unparseable start", () => {
    const bad = { id: "x", title: "?", startsAt: NaN } as CalendarEvent
    expect(dueCalendarEvents({ events: [bad], minutesBefore: 45, now, alreadyFired: none }))
      .toEqual([])
  })
})

import { validateTrigger } from "../src/validate.js"

describe("calendar trigger validation", () => {
  it("accepts a lead time", () => {
    expect(validateTrigger({ type: "calendar", minutesBefore: 45 })).toEqual([])
  })

  it("accepts fire-at-start", () => {
    expect(validateTrigger({ type: "calendar", minutesBefore: 0 })).toEqual([])
  })

  it("requires minutesBefore, so the lead time is never implicit", () => {
    const errors = validateTrigger({ type: "calendar" })
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe("trigger.minutesBefore")
  })

  it("rejects a negative or fractional lead time", () => {
    expect(validateTrigger({ type: "calendar", minutesBefore: -5 })).toHaveLength(1)
    expect(validateTrigger({ type: "calendar", minutesBefore: 12.5 })).toHaveLength(1)
  })

  it("rejects a lead time beyond a day, which is almost always a units mistake", () => {
    expect(validateTrigger({ type: "calendar", minutesBefore: 4000 })).toHaveLength(1)
  })

  it("still names calendar in the unknown-type error", () => {
    const errors = validateTrigger({ type: "telepathy" })
    expect(errors[0].message).toContain("calendar")
  })
})

import { extractConnections, extractTrigger, extractTriggerConfig } from "../src/domain/jig-source.js"

const calendarJig = (extra = "") => `
import { jig, type Context } from "@jig/sdk"
${extra}
export default jig("brief", {
  trigger: { type: "calendar", minutesBefore: 45 },
  tools: [],
}, async (ctx: Context) => {})
`

describe("calendar trigger in jig source", () => {
  it("parses the lead time", () => {
    expect(extractTriggerConfig(calendarJig()).trigger)
      .toMatchObject({ type: "calendar", minutesBefore: 45 })
  })

  // The whole feature depends on composio being connected, so it has to show up
  // as a required connection everywhere connections are already surfaced: the
  // run preflight, the dashboard's connection list, and a connection's used-by.
  it("requires composio even when the jig imports nothing", () => {
    expect(extractConnections(calendarJig())).toEqual(["composio"])
  })

  it("does not list composio twice when the jig already imports it", () => {
    const code = calendarJig(`import { composio } from "@jig/connections/composio.js"`)
    expect(extractConnections(code)).toEqual(["composio"])
  })

  it("leaves non-calendar jigs alone", () => {
    const cron = `
import { jig } from "@jig/sdk"
export default jig("x", { trigger: { type: "cron", cron: "0 9 * * *" }, tools: [] }, async () => {})
`
    expect(extractConnections(cron)).toEqual([])
  })

  it("renders a trigger label instead of a blank cell", () => {
    expect(extractTrigger(calendarJig())).toBe("45m before each meeting")
  })

  it("labels fire-at-start readably", () => {
    const code = calendarJig().replace("minutesBefore: 45", "minutesBefore: 0")
    expect(extractTrigger(code)).toBe("At each meeting start")
  })
})

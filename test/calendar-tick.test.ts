import { describe, expect, it } from "bun:test"
import { calendarTick, type CalendarTickDeps } from "../src/scheduler/calendar-tick.js"


const MIN = 60_000
const NOW = 1_000 * MIN

function deps(over: Partial<CalendarTickDeps> = {}) {
  const started: Array<{ jigId: string; params: Record<string, unknown> }> = []
  const recorded: Array<{ jigId: string; eventId: string }> = []
  const base: CalendarTickDeps = {
    now: () => NOW,
    leadMinutesFor: () => 45,
    fetchEvents: async () => [{ id: "evt-1", title: "Sync", startsAt: NOW + 30 * MIN, attendees: ["a@b.c"] }],
    alreadyFired: () => new Set<string>(),
    recordFire: (jigId, eventId) => { recorded.push({ jigId, eventId }) },
    isRunning: () => false,
    startRun: async (jigId, params) => { started.push({ jigId, params }) },
    onError: () => {},
    ...over,
  }
  return { d: base, started, recorded }
}

describe("calendarTick", () => {
  it("starts a run and hands the jig the event as params", async () => {
    const { d, started } = deps()
    await calendarTick(["brief"], d)
    expect(started).toHaveLength(1)
    expect(started[0].jigId).toBe("brief")
    expect(started[0].params).toMatchObject({ event_id: "evt-1", title: "Sync", attendees: ["a@b.c"] })
  })

  // Recorded BEFORE the run starts: if the process dies mid-tick, the cost of
  // record-first is one missed briefing, and the cost of record-after is
  // sending the same briefing on every tick until it succeeds.
  it("records the fire before starting the run", async () => {
    const order: string[] = []
    const { d } = deps({
      recordFire: () => { order.push("record") },
      startRun: async () => { order.push("start") },
    })
    await calendarTick(["brief"], d)
    expect(order).toEqual(["record", "start"])
  })

  it("does not fire for an event it already fired for", async () => {
    const { d, started } = deps({ alreadyFired: () => new Set(["evt-1"]) })
    await calendarTick(["brief"], d)
    expect(started).toEqual([])
  })

  it("skips a jig that is already running", async () => {
    const { d, started } = deps({ isRunning: () => true })
    await calendarTick(["brief"], d)
    expect(started).toEqual([])
  })

  it("fires once per due event", async () => {
    const { d, started } = deps({
      fetchEvents: async () => [
        { id: "a", title: "One", startsAt: NOW + 10 * MIN },
        { id: "b", title: "Two", startsAt: NOW + 20 * MIN },
      ],
    })
    await calendarTick(["brief"], d)
    expect(started.map((s) => s.params.event_id)).toEqual(["a", "b"])
  })

  // One jig's calendar being unreachable must not stop every other calendar jig
  // in the same tick.
  it("keeps going when one jig's fetch fails", async () => {
    const errors: unknown[] = []
    let call = 0
    const { d, started } = deps({
      fetchEvents: async () => {
        if (call++ === 0) throw new Error("composio down")
        return [{ id: "evt-2", title: "Later", startsAt: NOW + 30 * MIN }]
      },
      onError: (_jigId, e) => { errors.push(e) },
    })
    await calendarTick(["broken", "healthy"], d)
    expect(errors).toHaveLength(1)
    expect(started.map((s) => s.jigId)).toEqual(["healthy"])
  })

  it("ignores a jig whose trigger is no longer a calendar one", async () => {
    const { d, started } = deps({ leadMinutesFor: () => null })
    await calendarTick(["brief"], d)
    expect(started).toEqual([])
  })
})

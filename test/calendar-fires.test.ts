import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, openDb, listCalendarFires, pruneCalendarFires, recordCalendarFire } from "../src/db.js"

describe("calendar fire dedup", () => {
  beforeEach(() => { openDb() })
  afterEach(() => {
    pruneCalendarFires(Number.MAX_SAFE_INTEGER)
    closeDb()
  })

  it("remembers that a jig fired for an event", () => {
    recordCalendarFire("brief", "evt-1", 1_000)
    expect(listCalendarFires("brief", 0).has("evt-1")).toBe(true)
  })

  // Two jigs can both watch the calendar; one firing must not suppress the other.
  it("keys on jig and event together", () => {
    recordCalendarFire("brief", "evt-1", 1_000)
    expect(listCalendarFires("other-jig", 0).has("evt-1")).toBe(false)
  })

  // A tick that fires and then crashes before recording would double-send on
  // retry, so recording twice must be harmless rather than a constraint error.
  it("is idempotent for the same jig and event", () => {
    recordCalendarFire("brief", "evt-1", 1_000)
    expect(() => recordCalendarFire("brief", "evt-1", 2_000)).not.toThrow()
    expect(listCalendarFires("brief", 0).size).toBe(1)
  })

  // Without pruning the table grows forever; without the `since` filter the
  // read grows with it and old ids suppress a legitimately reused event id.
  it("ignores fires older than the window", () => {
    recordCalendarFire("brief", "old", 1_000)
    recordCalendarFire("brief", "recent", 9_000)
    const recent = listCalendarFires("brief", 5_000)
    expect(recent.has("recent")).toBe(true)
    expect(recent.has("old")).toBe(false)
  })

  it("prunes what it no longer needs", () => {
    recordCalendarFire("brief", "old", 1_000)
    recordCalendarFire("brief", "recent", 9_000)
    pruneCalendarFires(5_000)
    expect(listCalendarFires("brief", 0).has("old")).toBe(false)
    expect(listCalendarFires("brief", 0).has("recent")).toBe(true)
  })
})

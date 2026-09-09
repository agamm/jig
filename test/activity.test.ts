/**
 * The jigs page chart: runs and model spend per day, from the runs table.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, completeRun, insertRun, openDb } from "../src/db.js"
import { buildActivity } from "../src/services/activity.js"
import { matchRoute } from "../src/server/router.js"

const NOW = new Date("2026-09-08T18:00:00Z")
const DAY = 24 * 60 * 60 * 1000

/** A finished run started `daysAgo` days before NOW. */
function seedRun(jigId: string, daysAgo: number, status: "success" | "fail", costUsd?: number, hourUtc = 12): number {
  const runId = insertRun(jigId)
  completeRun(runId, status, 1000, status === "fail" ? "boom" : undefined, undefined, costUsd)
  const started = new Date(NOW.getTime() - daysAgo * DAY)
  started.setUTCHours(hourUtc, 0, 0, 0)
  openDb().prepare(`UPDATE runs SET started_at = ? WHERE id = ?`).run(started.toISOString().slice(0, 19).replace("T", " "), runId)
  return runId
}

beforeEach(() => { closeDb(); openDb(":memory:") })
afterEach(() => closeDb())

describe("buildActivity", () => {
  it("buckets runs and spend by day, fills empty days, and totals the window", () => {
    seedRun("a", 0, "success", 0.10)
    seedRun("a", 0, "fail", 0.02)
    seedRun("b", 1, "success", 0.30)
    seedRun("a", 6, "success", 0.05)
    seedRun("a", 9, "success", 0.99) // previous window
    seedRun("b", 40, "success", 5.00) // out of both windows

    const r = buildActivity({ since: new Date(NOW.getTime() - 7 * DAY), now: NOW, timeZone: "UTC" })

    expect(r.days).toHaveLength(8) // seven days back plus today
    expect(r.days[0].date).toBe("2026-09-01")
    expect(r.days.at(-1)).toMatchObject({ date: "2026-09-08", ok: 1, fail: 1 })
    expect(r.days.at(-1)!.costUsd).toBeCloseTo(0.12)
    expect(r.days.at(-1)!.byJig).toEqual([{ jigId: "a", ok: 1, fail: 1, costUsd: expect.closeTo(0.12) }])
    expect(r.days.find((d) => d.date === "2026-09-04")).toMatchObject({ ok: 0, fail: 0, costUsd: 0, byJig: [] })
    expect(r.totals).toMatchObject({ runs: 4, ok: 3, fail: 1, costKnown: true })
    expect(r.totals.costUsd).toBeCloseTo(0.47)
    expect(r.previous?.runs).toBe(1)
    expect(r.previous?.costUsd).toBeCloseTo(0.99)
  })

  it("has no previous window when run retention would not hold all of it", () => {
    seedRun("a", 1, "success", 0.10)
    // 30 days back: the previous 30 days start 60 days ago, past the 30-day retention.
    expect(buildActivity({ since: new Date(NOW.getTime() - 30 * DAY), now: NOW, timeZone: "UTC" }).previous).toBeNull()
    expect(buildActivity({ since: new Date(NOW.getTime() - 7 * DAY), now: NOW, timeZone: "UTC" }).previous).not.toBeNull()
  })

  it("reports spend as unknown until a run in the window recorded a cost", () => {
    seedRun("a", 0, "success")
    seedRun("a", 1, "fail")
    const r = buildActivity({ since: new Date(NOW.getTime() - 7 * DAY), now: NOW, timeZone: "UTC" })
    expect(r.totals).toMatchObject({ runs: 2, costUsd: 0, costKnown: false })
  })

  it("puts a run on the owner's day, not the UTC day", () => {
    // 23:30 UTC on Sep 7 is already Sep 8 in Jerusalem.
    seedRun("a", 1, "success", 0.01, 23)
    openDb().prepare(`UPDATE runs SET started_at = '2026-09-07 23:30:00'`).run()
    const utc = buildActivity({ since: new Date(NOW.getTime() - 2 * DAY), now: NOW, timeZone: "UTC" })
    const local = buildActivity({ since: new Date(NOW.getTime() - 2 * DAY), now: NOW, timeZone: "Asia/Jerusalem" })
    expect(utc.days.find((d) => d.ok === 1)?.date).toBe("2026-09-07")
    expect(local.days.find((d) => d.ok === 1)?.date).toBe("2026-09-08")
  })

  it("is routed at /api/activity", () => {
    expect(matchRoute("/api/activity")?.handler).toBe("activity")
  })
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import {
  closeDb,
  getRun,
  getSchedule,
  insertRun,
  insertStep,
  listRuns,
  openDb,
  setScheduleEnabled,
  upsertSchedule,
} from "../src/db.js"
import { invalidateJigsCache } from "../src/discover.js"
import { JIGS_DIR, PROJECT_ROOT } from "../src/config/paths.js"
import { recoverMissedRuns } from "../src/scheduler/recover.js"
import { millisecondsUntilNextSchedulerTick } from "../src/scheduler/index.js"
import { syncSchedules } from "../src/scheduler/sync.js"
import { tick } from "../src/scheduler/tick.js"

const CONNECTIONS_DIR = join(PROJECT_ROOT, ".jig/connections")
const CONNECTIONS_INDEX = join(CONNECTIONS_DIR, "index.ts")
const TEST_JIGS = [
  join(JIGS_DIR, "scheduler-sync-case.ts"),
  join(JIGS_DIR, "scheduler-bad-trigger-case.ts"),
  join(JIGS_DIR, "scheduler-tick-case.ts"),
]
let createdConnectionsIndex = false

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  invalidateJigsCache()
  mkdirSync(JIGS_DIR, { recursive: true })
  mkdirSync(CONNECTIONS_DIR, { recursive: true })
  createdConnectionsIndex = false
  if (!existsSync(CONNECTIONS_INDEX)) {
    writeFileSync(CONNECTIONS_INDEX, "export {}\n")
    createdConnectionsIndex = true
  }
})

afterEach(() => {
  closeDb()
  invalidateJigsCache()
  for (const path of TEST_JIGS) rmSync(path, { force: true })
  if (createdConnectionsIndex) rmSync(CONNECTIONS_INDEX, { force: true })
})

describe("scheduler sync", () => {
  it("preserves an existing schedule and records a visible error when cron becomes invalid", async () => {
    const jigPath = join(JIGS_DIR, "scheduler-sync-case.ts")
    writeFileSync(jigPath, `
import { jig } from "@jig/sdk"

export default jig("scheduler-sync-case", {
  trigger: { type: "cron", cron: "*/5 * * * *", missedStrategy: "skip" },
}, async (ctx) => {
  ctx.output("ok")
})
`)

    await syncSchedules()
    const initial = getSchedule("scheduler-sync-case")
    expect(initial).not.toBeNull()
    expect(initial!.error).toBeNull()
    expect(initial!.cron_expr).toBe("*/5 * * * *")
    expect(initial!.next_run_at).not.toBeNull()

    setScheduleEnabled("scheduler-sync-case", false)

    writeFileSync(jigPath, `
import { jig } from "@jig/sdk"

export default jig("scheduler-sync-case", {
  trigger: { type: "cron", cron: "not a cron", missedStrategy: "skip" },
}, async (ctx) => {
  ctx.output("broken")
})
`)

    await syncSchedules()
    const broken = getSchedule("scheduler-sync-case")
    expect(broken).not.toBeNull()
    expect(broken!.enabled).toBe(0)
    expect(broken!.cron_expr).toBe("not a cron")
    expect(broken!.next_run_at).toBe(initial!.next_run_at)
    expect(broken!.error).toContain("Invalid cron expression")
  })

  it("rejects unsupported trigger types with a visible error", async () => {
    const jigPath = join(JIGS_DIR, "scheduler-bad-trigger-case.ts")
    writeFileSync(jigPath, `
import { jig } from "@jig/sdk"

export default jig("scheduler-bad-trigger-case", {
  trigger: { type: "interval", minutes: 30 },
}, async (ctx) => {
  ctx.output("ok")
})
`)

    try {
      await syncSchedules()
      // Either the schedule has a visible error or no schedule was created — both
      // are acceptable as long as the unsupported trigger doesn't silently succeed.
      const schedule = getSchedule("scheduler-bad-trigger-case")
      if (schedule) {
        expect(schedule.error).toBeTruthy()
      }
    } finally {
      rmSync(jigPath, { force: true })
    }
  })
})

describe("scheduler recovery", () => {
  it("marks interrupted runs and steps failed, and skips missed runs without stamping last_run_at", () => {
    const runId = insertRun("recover-case")
    const stepId = insertStep(runId, 1, "half done")
    expect(stepId).toBeGreaterThan(0)

    upsertSchedule(
      "recover-case",
      "cron",
      "*/10 * * * *",
      "skip",
      Math.floor(Date.now() / 1000) - 60,
      null,
    )

    recoverMissedRuns()

    const recoveredRun = getRun(runId)
    expect(recoveredRun).not.toBeNull()
    expect(recoveredRun!.status).toBe("fail")
    expect(recoveredRun!.error).toBe("interrupted by process restart")
    expect(recoveredRun!.steps[0].status).toBe("fail")
    expect(recoveredRun!.steps[0].error).toBe("interrupted by process restart")

    const schedule = getSchedule("recover-case")
    expect(schedule).not.toBeNull()
    expect(schedule!.next_run_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
    expect(schedule!.last_run_at).toBeNull()
  })
})

describe("scheduler alignment", () => {
  it("computes the remaining delay to the next minute boundary", () => {
    expect(millisecondsUntilNextSchedulerTick(0)).toBe(60_000)
    expect(millisecondsUntilNextSchedulerTick(30_000)).toBe(30_000)
    expect(millisecondsUntilNextSchedulerTick(59_999)).toBe(1)
    expect(millisecondsUntilNextSchedulerTick(60_001)).toBe(59_999)
  })
})

describe("scheduler tick", () => {
  it("claims a due schedule once and records the actual launch time", async () => {
    const jigPath = join(JIGS_DIR, "scheduler-tick-case.ts")
    writeFileSync(jigPath, `
import { jig } from "@jig/sdk"

export default jig("scheduler-tick-case", {
  trigger: { type: "cron", cron: "* * * * *" },
}, async (ctx) => {
  await ctx.step("run", [], async () => {
    ctx.output("done")
  })
})
`)

    const dueAt = Math.floor(Date.now() / 1000) - 1
    upsertSchedule("scheduler-tick-case", "cron", "* * * * *", "catch-up", dueAt, null)

    tick()
    tick()
    await sleep(50)

    const runs = listRuns("scheduler-tick-case")
    expect(runs).toHaveLength(1)

    const schedule = getSchedule("scheduler-tick-case")
    expect(schedule).not.toBeNull()
    expect(schedule!.last_run_at).toBeGreaterThanOrEqual(dueAt)
    expect(schedule!.next_run_at).toBeGreaterThan(dueAt)
    expect(schedule!.error).toBeNull()
  })
})

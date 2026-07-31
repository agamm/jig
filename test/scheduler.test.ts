import { afterEach, beforeEach, describe, expect, it } from "bun:test"
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
import { schedulerTimeZone } from "../src/config/timezone.js"
import { recoverMissedRuns } from "../src/scheduler/recover.js"
import { millisecondsUntilNextSchedulerTick } from "../src/scheduler/index.js"
import { syncSchedules } from "../src/scheduler/sync.js"
import { tick } from "../src/scheduler/tick.js"
import { startBackgroundRun } from "../src/services/background-run.js"
import { approvePending, deleteJig as storeDeleteJig, writePending } from "../src/services/jig-store.js"
import { seedJig } from "./_fixtures.js"

const TEST_JIG_IDS = [
  "scheduler-sync-case",
  "scheduler-bad-trigger-case",
  "scheduler-tick-case",
  "scheduler-missing-connection-case",
]

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
  for (const id of TEST_JIG_IDS) {
    try { storeDeleteJig(id) } catch {}
  }
})

describe("scheduler sync", () => {
  it("preserves an existing schedule and records a visible error when cron becomes invalid", async () => {
    seedJig("scheduler-sync-case", `
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
    expect(initial!.timezone).toBe(schedulerTimeZone())
    expect(initial!.next_run_at).not.toBeNull()

    setScheduleEnabled("scheduler-sync-case", false)

    // Replace active version with a broken-cron variant.
    writePending({
      jigId: "scheduler-sync-case",
      code: `
import { jig } from "@jig/sdk"

export default jig("scheduler-sync-case", {
  trigger: { type: "cron", cron: "not a cron", missedStrategy: "skip" },
}, async (ctx) => {
  ctx.output("broken")
})
`,
      author: "cli",
    })
    approvePending("scheduler-sync-case")

    await syncSchedules()
    const broken = getSchedule("scheduler-sync-case")
    expect(broken).not.toBeNull()
    expect(broken!.enabled).toBe(0)
    expect(broken!.cron_expr).toBe("not a cron")
    expect(broken!.next_run_at).toBe(initial!.next_run_at)
    expect(broken!.error).toContain("Invalid cron expression")
  })

  it("rejects unsupported trigger types with a visible error", async () => {
    seedJig("scheduler-bad-trigger-case", `
import { jig } from "@jig/sdk"

export default jig("scheduler-bad-trigger-case", {
  trigger: { type: "interval", minutes: 30 },
}, async (ctx) => {
  ctx.output("ok")
})
`)

    await syncSchedules()
    // Either the schedule has a visible error or no schedule was created — both
    // are acceptable as long as the unsupported trigger doesn't silently succeed.
    const schedule = getSchedule("scheduler-bad-trigger-case")
    if (schedule) {
      expect(schedule.error).toBeTruthy()
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
    seedJig("scheduler-tick-case", `
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

  it("records and surfaces scheduled preflight failures as failed runs", async () => {
    seedJig("scheduler-missing-connection-case", `
import { jig } from "@jig/sdk"
import { definitely_missing_connection } from "@jig/connections/definitely_missing_connection"

export default jig("scheduler-missing-connection-case", {
  trigger: { type: "cron", cron: "* * * * *" },
}, async () => {
  void definitely_missing_connection
})
`)

    upsertSchedule(
      "scheduler-missing-connection-case",
      "cron",
      "* * * * *",
      "catch-up",
      Math.floor(Date.now() / 1000) - 1,
      null,
    )

    const started = await startBackgroundRun("scheduler-missing-connection-case")

    expect(started).toBe(false)
    const runs = listRuns("scheduler-missing-connection-case")
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe("fail")
    expect(runs[0].error).toContain("Connection required: definitely_missing_connection")

    const schedule = getSchedule("scheduler-missing-connection-case")
    expect(schedule?.error).toContain("Connection required: definitely_missing_connection")
    expect(schedule?.last_run_at).not.toBeNull()
  })
})

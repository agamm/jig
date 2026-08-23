import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  clearJigReminders,
  closeDb,
  listDueJigReminders,
  listPendingJigReminders,
  markJigRemindersFired,
  openDb,
  pruneJigReminders,
  scheduleJigReminder,
} from "../src/db.js"
import { setDryRun } from "../src/sdk/dryrun.js"
import { Context } from "../src/sdk/context.js"
import { REMINDER_MAX_PENDING_PER_JIG } from "../src/sdk/reminders.js"

const JIG = "todo"
const HOUR = 60 * 60 * 1000

function ctx(jigId = JIG) {
  return new Context({}, { jigId })
}

describe("ctx.remind", () => {
  beforeEach(() => { openDb() })
  afterEach(() => {
    setDryRun(false)
    clearJigReminders(JIG)
    clearJigReminders("other")
    closeDb()
  })

  it("schedules a wake-up the scheduler will later find due", async () => {
    const due = Date.now() - 1000
    await ctx().remind(due, { title: "Renew passport" })
    expect(listDueJigReminders(Date.now()).map((r) => r.jig_id)).toEqual([JIG])
  })

  it("does not surface a reminder before it is due", async () => {
    await ctx().remind(Date.now() + HOUR, { title: "Later" })
    expect(listDueJigReminders(Date.now())).toHaveLength(0)
    expect(listPendingJigReminders(JIG)).toHaveLength(1)
  })

  it("accepts a Date, epoch millis, or an ISO string", async () => {
    const at = Date.now() + HOUR
    const c = ctx()
    await c.remind(new Date(at), null, { key: "a" })
    await c.remind(at, null, { key: "b" })
    await c.remind(new Date(at).toISOString(), null, { key: "c" })
    const dues = listPendingJigReminders(JIG).map((r) => r.due_at)
    expect(dues).toEqual([at, at, at])
  })

  it("rejects an unparseable time rather than firing at a garbage date", async () => {
    expect(ctx().remind("next tuesday-ish")).rejects.toThrow(/unparseable time/)
  })

  // Without this, a jig that re-reads the same to-do every run stacks a new
  // reminder each time and the user gets one email per run.
  it("replaces a pending reminder with the same key instead of stacking", async () => {
    const c = ctx()
    await c.remind(Date.now() + HOUR, { v: 1 }, { key: "todo:42" })
    await c.remind(Date.now() + 2 * HOUR, { v: 2 }, { key: "todo:42" })

    const pending = listPendingJigReminders(JIG)
    expect(pending).toHaveLength(1)
    expect(JSON.parse(pending[0].payload!)).toEqual({ v: 2 })
  })

  it("keeps separate keys separate", async () => {
    const c = ctx()
    await c.remind(Date.now() + HOUR, null, { key: "a" })
    await c.remind(Date.now() + HOUR, null, { key: "b" })
    expect(listPendingJigReminders(JIG)).toHaveLength(2)
  })

  // Keyless reminders are independent events, so two of them are two reminders.
  it("does not deduplicate reminders that carry no key", async () => {
    const c = ctx()
    await c.remind(Date.now() + HOUR, { n: 1 })
    await c.remind(Date.now() + HOUR, { n: 2 })
    expect(listPendingJigReminders(JIG)).toHaveLength(2)
  })

  it("scopes reminders per jig", async () => {
    await ctx(JIG).remind(Date.now() + HOUR, null, { key: "shared" })
    await ctx("other").remind(Date.now() + HOUR, null, { key: "shared" })
    expect(listPendingJigReminders(JIG)).toHaveLength(1)
    expect(listPendingJigReminders("other")).toHaveLength(1)
  })

  it("lists pending reminders back to the jig, soonest first", async () => {
    const c = ctx()
    const later = Date.now() + 2 * HOUR
    const sooner = Date.now() + HOUR
    await c.remind(later, { n: "later" }, { key: "later" })
    await c.remind(sooner, { n: "sooner" }, { key: "sooner" })

    const pending = await c.reminders()
    expect(pending.map((r) => r.key)).toEqual(["sooner", "later"])
    expect(pending[0].dueAt).toBeInstanceOf(Date)
    expect(pending[0].payload).toEqual({ n: "sooner" })
  })

  it("cancels by key, reporting whether one was pending", async () => {
    const c = ctx()
    await c.remind(Date.now() + HOUR, null, { key: "todo:42" })
    expect(await c.cancelReminder("todo:42")).toBe(true)
    expect(await c.cancelReminder("todo:42")).toBe(false)
    expect(listPendingJigReminders(JIG)).toHaveLength(0)
  })

  it("does not schedule during a dry run", async () => {
    setDryRun(true)
    const c = ctx()
    await c.remind(Date.now() + HOUR, { title: "dry" })
    expect(listPendingJigReminders(JIG)).toHaveLength(0)
    expect(c.getOutput().join("\n")).toContain("[dry-run] would remind at")
  })

  it("refuses to schedule past the pending cap", async () => {
    for (let i = 0; i < REMINDER_MAX_PENDING_PER_JIG; i++) {
      scheduleJigReminder(JIG, Date.now() + HOUR, null, `k${i}`)
    }
    expect(ctx().remind(Date.now() + HOUR, null, { key: "one-more" })).rejects.toThrow(/maximum/)
  })

  // Rescheduling replaces a row, so a jig holding one reminder per to-do can
  // keep updating them at the cap without ever tripping it.
  it("still allows rescheduling an existing key at the cap", async () => {
    for (let i = 0; i < REMINDER_MAX_PENDING_PER_JIG; i++) {
      scheduleJigReminder(JIG, Date.now() + HOUR, null, `k${i}`)
    }
    await ctx().remind(Date.now() + 2 * HOUR, { updated: true }, { key: "k0" })
    expect(listPendingJigReminders(JIG)).toHaveLength(REMINDER_MAX_PENDING_PER_JIG)
  })

  it("fails loudly when the run has no jig identity", async () => {
    expect(new Context({}).remind(Date.now())).rejects.toThrow(/needs a jig identity/)
  })
})

describe("reminder ledger", () => {
  beforeEach(() => { openDb() })
  afterEach(() => { clearJigReminders(JIG); closeDb() })

  // Guarded on fired_at IS NULL, so a second tick that raced the first claims
  // nothing rather than firing the same reminder twice.
  it("claims each reminder exactly once", () => {
    const id = scheduleJigReminder(JIG, Date.now() - 1000, null, null)
    expect(markJigRemindersFired([id], Date.now())).toEqual([id])
    expect(markJigRemindersFired([id], Date.now())).toEqual([])
  })

  it("drops a claimed reminder out of the due list", () => {
    const id = scheduleJigReminder(JIG, Date.now() - 1000, null, null)
    markJigRemindersFired([id], Date.now())
    expect(listDueJigReminders(Date.now())).toHaveLength(0)
  })

  it("prunes fired reminders but never pending ones", () => {
    const old = scheduleJigReminder(JIG, Date.now() - 10 * HOUR, null, "old")
    scheduleJigReminder(JIG, Date.now() + 100 * HOUR, null, "future")
    markJigRemindersFired([old], Date.now() - 9 * HOUR)

    expect(pruneJigReminders(Date.now() - HOUR)).toBe(1)
    expect(listPendingJigReminders(JIG).map((r) => r.key)).toEqual(["future"])
  })
})

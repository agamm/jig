import { describe, expect, it } from "bun:test"
import { reminderTick, type ReminderTickDeps } from "../src/scheduler/reminder-tick.js"
import type { JigReminderRow } from "../src/db.js"

const MIN = 60_000
const NOW = 1_000 * MIN

function row(over: Partial<JigReminderRow> = {}): JigReminderRow {
  return {
    id: 1,
    jig_id: "todo",
    key: null,
    due_at: NOW - MIN,
    payload: null,
    created_at: NOW - 10 * MIN,
    fired_at: null,
    ...over,
  }
}

function deps(over: Partial<ReminderTickDeps> = {}) {
  const started: Array<{ jigId: string; params: Record<string, unknown> }> = []
  const claimed: number[][] = []
  const base: ReminderTickDeps = {
    now: () => NOW,
    listDue: () => [row()],
    isEnabled: () => true,
    isRunning: () => false,
    markFired: (ids) => { claimed.push(ids); return ids },
    startRun: async (jigId, params) => { started.push({ jigId, params }) },
    onError: () => {},
    ...over,
  }
  return { d: base, started, claimed }
}

describe("reminderTick", () => {
  it("wakes the jig with the due reminder in ctx.params.reminders", async () => {
    const { d, started } = deps({
      listDue: () => [row({ key: "todo:42", payload: JSON.stringify({ title: "Renew passport" }) })],
    })
    await reminderTick(d)

    expect(started).toHaveLength(1)
    expect(started[0].jigId).toBe("todo")
    expect(started[0].params).toEqual({
      reminders: [{
        key: "todo:42",
        payload: { title: "Renew passport" },
        dueAt: new Date(NOW - MIN).toISOString(),
      }],
    })
  })

  // One run carrying every due payload, not one run per reminder: only one run
  // per jig may be active, so per-reminder runs would stretch a batch across as
  // many minutes as there are reminders and send N emails instead of one list.
  it("batches all of a jig's due reminders into a single run", async () => {
    const { d, started } = deps({
      listDue: () => [
        row({ id: 1, key: "a", payload: JSON.stringify({ n: 1 }) }),
        row({ id: 2, key: "b", payload: JSON.stringify({ n: 2 }) }),
        row({ id: 3, key: "c", payload: JSON.stringify({ n: 3 }) }),
      ],
    })
    await reminderTick(d)

    expect(started).toHaveLength(1)
    expect(started[0].params.reminders).toHaveLength(3)
  })

  it("starts one run per jig when several have reminders due", async () => {
    const { d, started } = deps({
      listDue: () => [
        row({ id: 1, jig_id: "todo" }),
        row({ id: 2, jig_id: "followups" }),
      ],
    })
    const woken = await reminderTick(d)

    expect(woken).toBe(2)
    expect(started.map((s) => s.jigId).sort()).toEqual(["followups", "todo"])
  })

  // Claim-first: if the process dies between the two, one reminder is missed.
  // Claim-after would resend it on every tick until a run happened to survive.
  it("claims the reminders before starting the run", async () => {
    const order: string[] = []
    const { d } = deps({
      markFired: (ids) => { order.push("claim"); return ids },
      startRun: async () => { order.push("start") },
    })
    await reminderTick(d)
    expect(order).toEqual(["claim", "start"])
  })

  it("fires only the reminders it actually claimed", async () => {
    // A concurrent tick already took id 2, so markFired returns only id 1.
    const { d, started } = deps({
      listDue: () => [
        row({ id: 1, key: "mine", payload: JSON.stringify({ n: 1 }) }),
        row({ id: 2, key: "theirs", payload: JSON.stringify({ n: 2 }) }),
      ],
      markFired: () => [1],
    })
    await reminderTick(d)

    expect(started[0].params.reminders).toEqual([
      { key: "mine", payload: { n: 1 }, dueAt: new Date(NOW - MIN).toISOString() },
    ])
  })

  it("does not start a run when every reminder was already claimed", async () => {
    const { d, started } = deps({ markFired: () => [] })
    await reminderTick(d)
    expect(started).toHaveLength(0)
  })

  // Leaving them pending rather than consuming them is the point: re-enabling
  // the jig then delivers what came due while it was paused.
  it("leaves reminders pending for a paused jig", async () => {
    const { d, started, claimed } = deps({ isEnabled: () => false })
    await reminderTick(d)
    expect(started).toHaveLength(0)
    expect(claimed).toHaveLength(0)
  })

  it("leaves reminders pending while a run is already in flight", async () => {
    const { d, started, claimed } = deps({ isRunning: () => true })
    await reminderTick(d)
    expect(started).toHaveLength(0)
    expect(claimed).toHaveLength(0)
  })

  it("keeps delivering to other jigs when one fails to start", async () => {
    const errors: string[] = []
    const ran: string[] = []
    const { d } = deps({
      listDue: () => [row({ id: 1, jig_id: "broken" }), row({ id: 2, jig_id: "fine" })],
      startRun: async (jigId) => {
        if (jigId === "broken") throw new Error("boom")
        ran.push(jigId)
      },
      onError: (jigId) => { errors.push(jigId) },
    })
    await reminderTick(d)

    expect(errors).toEqual(["broken"])
    expect(ran).toEqual(["fine"])
  })

  it("hands back a null payload when the reminder carried none", async () => {
    const { d, started } = deps({ listDue: () => [row({ key: "bare", payload: null })] })
    await reminderTick(d)
    expect(started[0].params.reminders).toEqual([
      { key: "bare", payload: null, dueAt: new Date(NOW - MIN).toISOString() },
    ])
  })
})

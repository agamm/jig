/**
 * End-to-end proof of the remember-then-act loop, through the real runner and
 * the real scheduler tick, not the injected-dependency seams the unit tests
 * use. This is the test that would catch the plumbing being wrong even when
 * every piece works in isolation: jigId not reaching the Context, the tick not
 * consuming reminders, payloads not arriving in ctx.params.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  clearJigMemory,
  clearJigReminders,
  closeDb,
  getJigMemory,
  listPendingJigReminders,
  listRuns,
  openDb,
  scheduleJigReminder,
} from "../src/db.js"
import { tick } from "../src/scheduler/tick.js"
import { startBackgroundRun } from "../src/services/background-run.js"
import { deleteJig as storeDeleteJig } from "../src/services/jig-store.js"
import { seedJig } from "./_fixtures.js"

const JIG = "memory-loop-case"

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * A miniature to-do jig: mail (simulated via params) files an item and sets a
 * reminder; a reminder firing reads the item back and marks it delivered.
 */
const TODO_JIG = `
import { jig } from "@jig/sdk"

export default jig("${JIG}", { trigger: { type: "manual" } }, async (ctx) => {
  const due = (ctx.params.reminders ?? []) as Array<{ key: string | null }>

  if (due.length > 0) {
    await ctx.step("deliver", [], async () => {
      const delivered: string[] = []
      for (const r of due) {
        if (!r.key) continue
        const todo = await ctx.memory.get<{ title: string }>(r.key)
        if (todo) {
          delivered.push(todo.title)
          await ctx.memory.set(r.key, { ...todo, delivered: true })
        }
      }
      ctx.output("delivered: " + delivered.join(", "))
    })
    return
  }

  await ctx.step("file", [], async () => {
    const title = String(ctx.params.title ?? "untitled")
    const key = "todo:" + title
    await ctx.memory.set(key, { title, delivered: false })
    await ctx.remind(Date.now() - 1000, null, { key })
    ctx.output("filed: " + title)
  })
})
`

describe("memory + reminder loop", () => {
  beforeEach(() => {
    closeDb()
    openDb(":memory:")
    seedJig(JIG, TODO_JIG)
  })

  afterEach(() => {
    clearJigMemory(JIG)
    clearJigReminders(JIG)
    closeDb()
    try { storeDeleteJig(JIG) } catch {}
  })

  it("carries state from one run to the next, woken by the scheduler", async () => {
    // Run 1: file a to-do. Proves ctx.memory and ctx.remind reach the database
    // through the real runner, which needs jigId to have survived the plumbing.
    await startBackgroundRun(JIG, { title: "Renew passport" })

    expect(getJigMemory(JIG, "todo:Renew passport")).not.toBeNull()
    expect(listPendingJigReminders(JIG)).toHaveLength(1)

    // Run 2: the scheduler notices the reminder is due and wakes the jig with
    // it. Nothing else in this test starts that run.
    tick()
    await sleep(250)

    const stored = JSON.parse(getJigMemory(JIG, "todo:Renew passport")!)
    expect(stored).toEqual({ title: "Renew passport", delivered: true })

    // The reminder is consumed, so a later tick cannot deliver it twice.
    expect(listPendingJigReminders(JIG)).toHaveLength(0)

    const runs = listRuns(JIG)
    expect(runs).toHaveLength(2)
    expect(runs.every((r) => r.status === "success")).toBe(true)
    expect(runs.map((r) => r.output).join("\n")).toContain("delivered: Renew passport")
  })

  it("does not re-deliver a reminder on the next tick", async () => {
    await startBackgroundRun(JIG, { title: "Once only" })
    tick()
    await sleep(250)
    tick()
    await sleep(150)

    const runs = listRuns(JIG)
    expect(runs).toHaveLength(2)
  })

  it("delivers several due reminders in one run rather than one run each", async () => {
    scheduleJigReminder(JIG, Date.now() - 1000, null, "todo:A")
    scheduleJigReminder(JIG, Date.now() - 1000, null, "todo:B")

    tick()
    await sleep(250)

    const runs = listRuns(JIG)
    expect(runs).toHaveLength(1)
  })
})

/**
 * End-to-end over the refactored run path: seed -> run -> edit -> approve ->
 * run again, exercising services/run-core.ts, jig-store's version lifecycle,
 * and the runner, with no network and no LLM.
 *
 * This is the automated form of the manual create/run/edit/run drive-through.
 * It deliberately covers the two things that were broken or duplicated before:
 * the run path used to exist as two hand-synced copies (run-api /
 * background-run), and an edit had to actually change what the next run
 * executed — the CLI used to read stale source off disk instead.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, getRun, listRuns, openDb } from "../src/db.js"
import { startJigRun } from "../src/services/run-api.js"
import { startBackgroundRun } from "../src/services/background-run.js"
import { prepareRun } from "../src/services/run-core.js"
import { resetRunStoreForTests } from "../src/services/run-store.js"
import { approvePending, deleteJig, getActiveCode, writePending } from "../src/services/jig-store.js"
import { seedJig } from "./_fixtures.js"

const JIG_ID = "run-lifecycle-case"

function jigSource(greeting: string): string {
  return `
import { jig } from "@jig/sdk"

export default jig("${JIG_ID}", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("greet", [], async () => {
    ctx.output("${greeting}")
  })
})
`
}

/** Runs start in the background; wait for the row to reach a terminal status. */
async function waitForRun(runId: number, timeoutMs = 5000): Promise<ReturnType<typeof getRun>> {
  const start = Date.now()
  for (;;) {
    const run = getRun(runId)
    if (run && run.status !== "running") return run
    if (Date.now() - start > timeoutMs) throw new Error(`run ${runId} did not finish in ${timeoutMs}ms`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  resetRunStoreForTests()
})

afterEach(() => {
  try { deleteJig(JIG_ID) } catch {}
  closeDb()
})

describe("run lifecycle", () => {
  it("runs the active version, then runs the edited version after approval", async () => {
    seedJig(JIG_ID, jigSource("first version"))

    const first = await startJigRun(JIG_ID, {})
    const firstRun = await waitForRun(first.runId)
    expect(firstRun!.status).toBe("success")
    expect(firstRun!.output).toContain("first version")

    // An edit lands as pending and must NOT change what runs yet.
    writePending({ jigId: JIG_ID, code: jigSource("second version"), author: "agent", message: "edit" })
    expect(getActiveCode(JIG_ID)).toContain("first version")

    const stillFirst = await startJigRun(JIG_ID, {})
    const stillFirstRun = await waitForRun(stillFirst.runId)
    expect(stillFirstRun!.output).toContain("first version")

    // Approving promotes pending to active; the next run picks it up.
    approvePending(JIG_ID)
    const second = await startJigRun(JIG_ID, {})
    const secondRun = await waitForRun(second.runId)
    expect(secondRun!.status).toBe("success")
    expect(secondRun!.output).toContain("second version")
  })

  it("records step rows for each run", async () => {
    seedJig(JIG_ID, jigSource("stepped"))
    const { runId } = await startJigRun(JIG_ID, {})
    const run = await waitForRun(runId)
    expect(run!.steps).toHaveLength(1)
    expect(run!.steps[0].label).toBe("greet")
    expect(run!.steps[0].status).toBe("success")
  })

  it("rejects a second concurrent run of the same jig", async () => {
    seedJig(JIG_ID, jigSource("concurrent"))
    const { runId } = await startJigRun(JIG_ID, {})
    await expect(startJigRun(JIG_ID, {})).rejects.toThrow("already in progress")
    await waitForRun(runId)
  })

  it("shares the same execution path with the scheduler's background run", async () => {
    seedJig(JIG_ID, jigSource("from scheduler"))
    const started = await startBackgroundRun(JIG_ID)
    expect(started).toBe(true)

    const runs = listRuns(JIG_ID)
    expect(runs).toHaveLength(1)
    const run = await waitForRun(runs[0].id)
    expect(run!.status).toBe("success")
    expect(run!.output).toContain("from scheduler")
  })

  it("dry runs without recording a run row", async () => {
    seedJig(JIG_ID, jigSource("dry"))
    const before = listRuns(JIG_ID).length
    const { runId, dryRun } = await startJigRun(JIG_ID, { dryRun: true })
    expect(dryRun).toBe(true)
    // Dry runs use a negative sentinel id and never touch the runs table.
    expect(runId).toBeLessThan(0)
    expect(listRuns(JIG_ID).length).toBe(before)
  })
})

describe("prepareRun", () => {
  it("reports a missing jig distinctly from one with no approved version", async () => {
    expect(await prepareRun("no-such-jig")).toEqual({ ok: false, reason: "not-found" })

    writePending({ jigId: JIG_ID, code: jigSource("unapproved"), author: "agent" })
    expect(await prepareRun(JIG_ID)).toEqual({ ok: false, reason: "no-active-version" })
  })

  it("reports the specific connections a jig needs before it can run", async () => {
    seedJig(JIG_ID, `
import { jig } from "@jig/sdk"
import { definitely_missing } from "@jig/connections/definitely_missing"

export default jig("${JIG_ID}", { trigger: { type: "manual" } }, async () => {
  void definitely_missing
})
`)
    const prepared = await prepareRun(JIG_ID)
    expect(prepared.ok).toBe(false)
    if (prepared.ok) throw new Error("expected preflight to fail")
    expect(prepared.reason).toBe("missing-connections")
    if (prepared.reason !== "missing-connections") throw new Error("unreachable")
    expect(prepared.missing).toEqual(["definitely_missing"])
    expect(prepared.message).toBe("Connection required: definitely_missing")
  })

  it("resolves a runnable path for an approved jig", async () => {
    seedJig(JIG_ID, jigSource("runnable"))
    const prepared = await prepareRun(JIG_ID)
    expect(prepared.ok).toBe(true)
    if (!prepared.ok) throw new Error("expected preflight to pass")
    expect(prepared.jigPath).toContain(JIG_ID)
    expect(prepared.jigRow.id).toBe(JIG_ID)
  })
})

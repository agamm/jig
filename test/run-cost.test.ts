/**
 * Model spend per run: every OpenRouter call asks for usage accounting, each
 * response's cost lands on the run's context, and the finished run row keeps
 * the sum. That sum is what the jigs page chart and the cost chips show.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, getRun, openDb, setCredential } from "../src/db.js"
import { resetRunStoreForTests } from "../src/services/run-store.js"
import { startJigRun } from "../src/services/run-api.js"
import { deleteJig } from "../src/services/jig-store.js"
import { seedJig } from "./_fixtures.js"

const realFetch = globalThis.fetch
const JIG_ID = "run-cost-case"

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  setCredential("openrouter:api_key", "sk-or-test", "openrouter")
  resetRunStoreForTests()
})
afterEach(() => {
  globalThis.fetch = realFetch
  try { deleteJig(JIG_ID) } catch {}
  closeDb()
})

describe("run cost", () => {
  it("asks OpenRouter for usage accounting and records the summed cost on the run", async () => {
    const bodies: any[] = []
    globalThis.fetch = (async (_input: any, init?: any) => {
      bodies.push(JSON.parse(String(init?.body ?? "{}")))
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.0123 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      )
    }) as unknown as typeof fetch

    seedJig(JIG_ID, `
import { jig, llm } from "@jig/sdk"

export default jig("${JIG_ID}", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("twice", [], async () => {
    ctx.output(await llm("say ok", {}))
    ctx.output(await llm("say ok again", {}))
  })
})
`)
    const { runId } = await startJigRun(JIG_ID, {})
    const deadline = Date.now() + 5000
    let row = getRun(runId)
    while (!row || row.status === "running") {
      if (Date.now() > deadline) throw new Error("run did not finish")
      await new Promise((r) => setTimeout(r, 25))
      row = getRun(runId)
    }

    expect(row.status).toBe("success")
    expect(row.cost_usd).toBeCloseTo(0.0246, 6)
    expect(bodies.length).toBeGreaterThanOrEqual(2)
    for (const body of bodies) expect(body.usage).toEqual({ include: true })
  })
})

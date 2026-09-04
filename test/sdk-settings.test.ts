/**
 * Model and timeouts are declared in the jig source and nowhere else.
 *
 * Pins the model precedence chain (call > step > jig > global main model),
 * that `toolTimeoutMs` and `runTimeoutMs` on jig() reach the run, and that the
 * dashboard's step chips are derived from the same source the runtime reads.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, getRun, openDb, setCredential } from "../src/db.js"
import { Context } from "../src/sdk/context.js"
import { jig, run } from "../src/sdk/jig.js"
import { llm } from "../src/sdk/llm.js"
import { setModelOverrides } from "../src/config/models.js"
import { extractJigModel } from "../src/domain/jig-source.js"
import { parseStepsFromSource } from "../src/derive-steps.js"
import {
  finishTrackedRun,
  getRunStatus,
  getSignalForRun,
  rearmRunTimeout,
  resetRunStoreForTests,
  startTrackedRun,
} from "../src/services/run-store.js"
import { startJigRun } from "../src/services/run-api.js"
import { deleteJig } from "../src/services/jig-store.js"
import { seedJig } from "./_fixtures.js"

const realFetch = globalThis.fetch
const manual = { type: "manual" as const }
const E2E_JIG_ID = "sdk-settings-run-timeout"

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  setModelOverrides({ main: "global/main-model" })
  resetRunStoreForTests()
})

afterEach(() => {
  globalThis.fetch = realFetch
  try { deleteJig(E2E_JIG_ID) } catch {}
  closeDb()
})

describe("model precedence", () => {
  it("ctx.currentModel is the step model inside a step and the jig model outside", async () => {
    const ctx = new Context({})
    ctx.setBaseModel("vendor/jig-model")
    const seen: { inside?: string | null } = {}
    await ctx.step("Pick", [], async () => { seen.inside = ctx.currentModel }, { model: "vendor/step-model" })
    expect(seen.inside).toBe("vendor/step-model")
    expect(ctx.currentModel).toBe("vendor/jig-model")
  })

  it("a step without a model inherits the jig model, and null means the global default", async () => {
    const ctx = new Context({})
    const seen: { inside?: string | null } = {}
    await ctx.step("Plain", [], async () => { seen.inside = ctx.currentModel })
    expect(seen.inside).toBeNull()
    ctx.setBaseModel("vendor/jig-model")
    await ctx.step("Plain again", [], async () => { seen.inside = ctx.currentModel })
    expect(seen.inside).toBe("vendor/jig-model")
  })

  it("llm({ model }) beats the step model, which beats the jig model, which beats the global main model", async () => {
    setCredential("openrouter:api_key", "test-key", "openrouter")
    const requested: string[] = []
    globalThis.fetch = (async (_input: any, init?: any) => {
      requested.push(JSON.parse(init.body).model)
      return new Response(
        JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )
    }) as typeof fetch

    const declared = jig("precedence", { trigger: manual, model: "vendor/jig-model" }, async (ctx) => {
      await ctx.step("Call", [], async () => { await llm("p", {}, { model: "vendor/call-model" }) }, { model: "vendor/step-model" })
      await ctx.step("Step", [], async () => { await llm("p", {}) }, { model: "vendor/step-model" })
      await ctx.step("Jig", [], async () => { await llm("p", {}) })
    })
    await run(declared, {}, { silent: true })
    expect(requested).toEqual(["vendor/call-model", "vendor/step-model", "vendor/jig-model"])

    const undeclared = jig("global", { trigger: manual }, async (ctx) => {
      await ctx.step("Global", [], async () => { await llm("p", {}) })
    })
    await run(undeclared, {}, { silent: true })
    expect(requested.at(-1)).toBe("global/main-model")
  })
})

describe("timeouts from the definition", () => {
  it("toolTimeoutMs on jig() reaches the Context the handler runs in", async () => {
    const seen: { budget?: number | null } = {}
    const def = jig("tool-budget", { trigger: manual, toolTimeoutMs: 1234 }, async (ctx) => { seen.budget = ctx.toolTimeoutMs })
    await run(def, {}, { silent: true })
    expect(seen.budget).toBe(1234)
  })

  it("leaves the Context's toolTimeoutMs unset when the jig declares none", async () => {
    const seen: { budget?: number | null } = { budget: 5 }
    const def = jig("no-budget", { trigger: manual }, async (ctx) => { seen.budget = ctx.toolTimeoutMs })
    await run(def, {}, { silent: true })
    expect(seen.budget).toBeUndefined()
  })

  it("rearmRunTimeout swaps the default watchdog for the jig's budget", async () => {
    startTrackedRun(4242, "short-budget", true)
    rearmRunTimeout(4242, 20)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(getSignalForRun(4242)?.aborted).toBe(true)
    finishTrackedRun(4242)
    expect(getRunStatus(4242)?.error).toMatch(/timed out/)
  })

  it("rearmRunTimeout ignores a non-positive budget and an unknown run", async () => {
    startTrackedRun(4343, "default-budget", true)
    rearmRunTimeout(4343, 0)
    rearmRunTimeout(9999, 20)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(getSignalForRun(4343)?.aborted).toBe(false)
  })

  it("a tracked run is aborted by the runTimeoutMs its source declares", async () => {
    seedJig(E2E_JIG_ID, `
import { jig } from "@jig/sdk"

export default jig("${E2E_JIG_ID}", { trigger: { type: "manual" }, runTimeoutMs: 100 }, async (ctx) => {
  await ctx.step("hang until aborted", [], async () => {
    await new Promise((_resolve, reject) => {
      ctx.signal?.addEventListener("abort", () => reject(new Error("aborted")))
    })
  })
})
`)
    const { runId } = await startJigRun(E2E_JIG_ID, {})
    const deadline = Date.now() + 5000
    let row = getRun(runId)
    while (!row || row.status === "running") {
      if (Date.now() > deadline) throw new Error("run did not finish")
      await new Promise((resolve) => setTimeout(resolve, 25))
      row = getRun(runId)
    }
    expect(row.status).toBe("fail")
    expect(row.error).toMatch(/timed out/)
  })
})

describe("extractJigModel", () => {
  it("finds a model declared after the nested trigger object", () => {
    const code = `
import { jig } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace.js"

export default jig("nested", {
  trigger: { type: "cron", cron: "0 8 * * 1", missedStrategy: "skip" },
  tools: [workspace.gmail_search],
  model: "vendor/jig-model",
}, async (ctx) => {})`
    expect(extractJigModel(code)).toBe("vendor/jig-model")
  })

  it("ignores models set on steps or calls inside the handler", () => {
    const code = `
export default jig("handler-only", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("s", [], async () => {
    await llm("p", {}, { model: "vendor/call-model" })
  }, { model: "vendor/step-model" })
})`
    expect(extractJigModel(code)).toBeNull()
  })

  it("returns null without a jig() call", () => {
    expect(extractJigModel('const model = "vendor/x"')).toBeNull()
  })
})

describe("step chips read the source", () => {
  const source = (options: string, steps: string) => `
import { jig, llm, agent } from "@jig/sdk"

export default jig("chips", { trigger: { type: "manual" }${options} }, async (ctx) => {
${steps}
})`
  const llmChip = (step: { tools?: { connection: string; name: string }[] }) =>
    step.tools?.find((tool) => tool.connection === "llm")?.name

  it("labels a step by its fourth-argument model, else the jig model, with the call model on top", () => {
    const steps = parseStepsFromSource(source(', model: "vendor/jig-model"', `
  await ctx.step("Step model", [], async () => {
    await llm("p", {})
  }, { model: "vendor/step-model" })
  await ctx.step("Jig model", [], async () => {
    await llm("p", {})
  })
  await ctx.step("Call model", [], async () => {
    await llm("p", {}, { model: "vendor/call-model" })
  }, { model: "vendor/step-model" })
`))
    expect(steps.map(llmChip)).toEqual(["llm(step-model)", "llm(jig-model)", "llm(call-model)"])
  })

  it("falls back to the global main model when neither the step nor the jig declares one", () => {
    const [step] = parseStepsFromSource(source("", `
  await ctx.step("Global", [], async () => {
    await llm("p", {})
  })
`))
    expect(llmChip(step)).toBe("llm(main-model)")
  })

  it("does not mistake an llm({ model }) call inside the body for the step option", () => {
    const [step] = parseStepsFromSource(source("", `
  await ctx.step("Mixed", [], async () => {
    const a = await llm("p", { data }, { model: "vendor/call-model" })
    const b = await agent("q", [])
  })
`))
    expect(step.tools?.map((tool) => tool.name)).toEqual(["llm(call-model)", "agent(main-model)"])
  })
})

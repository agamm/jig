import { describe, expect, it } from "bun:test"
import { validateApifyBuildTimeResolution } from "../src/mcp/validators/apify.js"

describe("validateApifyBuildTimeResolution", () => {
  const apifyResolution = {
    server: "apify",
    resolvedTarget: "community/github-trending-scraper",
    resolvedInputSchema: {
      type: "object",
      properties: {
        since: { type: "string" },
        language: { type: "string" },
      },
      required: ["since"],
    },
  }

  it("accepts resolved Apify input fields passed through a local object variable", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor, apify.get_dataset_items] }, async (ctx) => {
  let datasetId = ""
  await ctx.step("Run", [apify.call_actor], async () => {
    const input = { since: ctx.params.since, language: "typescript" }
    const run = await apify.call_actor({ actor: "community/github-trending-scraper", input })
    datasetId = run.storages?.datasets?.default?.id
  })
  await ctx.step("Read rows", [apify.get_dataset_items], async () => {
    const items = await apify.get_dataset_items({ datasetId })
    ctx.output(String(items.length))
  })
})
`

    expect(validateApifyBuildTimeResolution({ code, resolution: apifyResolution })).toEqual([])
  })

  it("rejects calling an Actor and never reading its dataset", () => {
    // The exact defect an end-to-end run surfaced: the jig calls the Actor, then
    // feeds only datasetId/itemCount into llm(), which invents the answer while
    // the run still reports success.
    const code = `
import { jig, llm } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    const run = await apify.call_actor({ actor: "community/github-trending-scraper", input: { since: "weekly" } })
    const itemCount = run.storages?.datasets?.default?.itemCount ?? 0
    await llm("Summarize the results", { itemCount })
  })
})
`

    expect(validateApifyBuildTimeResolution({ code, resolution: apifyResolution })).toContainEqual({
      message:
        "apify.call_actor returns a run descriptor (status/stats/storages), not the Actor's output rows. "
        + "This code never calls apify.get_dataset_items, so it has no scraped data. "
        + "Add a step that reads the rows: `const items = await apify.get_dataset_items({ datasetId: run.storages?.datasets?.default?.id })`, "
        + "and derive the result from those items. Do not pass only a datasetId or itemCount into llm()/agent().",
    })
  })

  it("rejects get_actor_run used as a substitute for reading the dataset", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor, apify.get_actor_run] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    const run = await apify.call_actor({ actor: "community/github-trending-scraper", input: { since: "weekly" } })
    await apify.get_actor_run({ runId: run.runId })
  })
})
`

    expect(validateApifyBuildTimeResolution({ code, resolution: apifyResolution })).toContainEqual({
      message:
        "apify.get_actor_run returns run metadata only. To read an Actor's results use apify.get_dataset_items({ datasetId }).",
    })
  })

  it("rejects a different Apify actor when build-time discovery already resolved one", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    await apify.call_actor({ actorId: "apify/hello-world", input: "{}" })
  })
})
`

    expect(validateApifyBuildTimeResolution({ code, resolution: apifyResolution })).toContainEqual({
      message: 'Build-time discovery resolved the Apify actor to "community/github-trending-scraper". This code must call that exact actor instead of substituting a different one or a placeholder.',
    })
  })

  it("rejects apify.call_actor calls that use the wrong top-level params", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    await apify.call_actor({ actorId: "community/github-trending-scraper", input: JSON.stringify({ since: "weekly" }) })
  })
})
`

    expect(validateApifyBuildTimeResolution({ code, resolution: apifyResolution })).toContainEqual({
      message: "Use apify.call_actor with the MCP tool's exact params: pass `actor`, not `actorId`.",
    })
    expect(validateApifyBuildTimeResolution({ code, resolution: apifyResolution })).toContainEqual({
      message: "Use apify.call_actor with a real object for `input`. Do not pass JSON strings or JSON.stringify(...).",
    })
  })

  it("rejects missing required Apify actor input fields from build-time discovery", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    await apify.call_actor({ actor: "community/github-trending-scraper", input: { language: "typescript" } })
  })
})
`

    expect(validateApifyBuildTimeResolution({ code, resolution: apifyResolution })).toContainEqual({
      message: "Build-time discovery resolved required Apify actor input fields: since. The apify.call_actor input must provide them directly or map them from jig params/context.",
    })
  })
})

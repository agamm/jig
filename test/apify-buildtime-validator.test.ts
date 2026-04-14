import { describe, expect, it } from "vitest"
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

export default jig("x", { tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    const input = { since: ctx.params.since, language: "typescript" }
    await apify.call_actor({ actor: "community/github-trending-scraper", input })
  })
})
`

    expect(validateApifyBuildTimeResolution({ code, resolution: apifyResolution })).toEqual([])
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

import { describe, expect, it } from "bun:test"
import { checkPlaceholderJigPatterns, checkPreferCtxEmailForSelfGmail, checkStepToolDeclarations, checkToolDeclarations } from "../src/validate.js"

describe("checkToolDeclarations", () => {
  it("detects undeclared tool usage for @jig connection imports", () => {
    const code = `
import { workspace } from "@jig/connections/workspace.js"

await workspace.gmail_search({ query: "weekly update" })
`

    expect(checkToolDeclarations(code, [])).toEqual([
      {
        field: "tools.workspace.gmail_search",
        message: 'Tool "workspace.gmail_search" is used but not declared in the jig\'s tools array.',
      },
    ])
  })

  it("accepts sanitized tool identifiers when the declared tool name came from the raw MCP schema", () => {
    const code = `
import { apify } from "@jig/connections/apify.js"

await apify.search_actors({ query: "github trending" })
await apify.call_actor({ actorId: "apify/example" })
`

    expect(checkToolDeclarations(code, ["search-actors", "call-actor"])).toEqual([])
  })
})

describe("checkPlaceholderJigPatterns", () => {
  it("rejects instructional placeholder jigs that tell the user to connect later", () => {
    const code = `
import { jig, llm } from "@jig/sdk"

export default jig("github-trends", {
  trigger: { type: "manual" },
  tools: [],
}, async (ctx) => {
  await ctx.step("Get trending GitHub repositories info", [], async () => {
    ctx.output("This jig is designed to find trending GitHub repositories using Apify.")
    ctx.output("Run jig connect apify")
    ctx.output("Once connected, this jig will use Apify.")
    await llm("Generate example output of what trending GitHub repositories might look like", {})
  })
})
`

    const errors = checkPlaceholderJigPatterns(code)
    expect(errors.some((error) => error.field === "behavior.placeholder-output")).toBe(true)
    expect(errors.some((error) => error.field === "behavior.setup-instructions")).toBe(true)
    expect(errors.some((error) => error.field === "behavior.placeholder-jig")).toBe(true)
  })

  it("rejects imported-but-unused connections", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("github-trends", {
  trigger: { type: "manual" },
  tools: [],
}, async (ctx) => {
  await ctx.step("Explain", [], async () => {
    ctx.output("Waiting for setup")
  })
})
`

    const errors = checkPlaceholderJigPatterns(code)
    expect(errors).toContainEqual({
      field: "behavior.unused-connections",
      message: "Jig imports connections but never uses any connection tools. Do not import a service unless the jig actually uses it.",
    })
  })

  it("rejects agent-shaped placeholders that never pass the imported connection tools to runtime", () => {
    const code = `
import { jig, agent } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("github-trends", {
  trigger: { type: "manual" },
  tools: [],
}, async (ctx) => {
  await ctx.step("Explain", [], async () => {
    await agent("Explain what this jig would do", [])
    ctx.output("Once connected, this jig will use Apify.")
  })
})
`

    const errors = checkPlaceholderJigPatterns(code)
    expect(errors.some((error) => error.field === "behavior.placeholder-jig")).toBe(true)
    expect(errors.some((error) => error.field === "behavior.unused-connections")).toBe(true)
  })

  it("accepts a real connection-backed jig", () => {
    const code = `
import { jig, agent } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("github-trends", {
  trigger: { type: "manual" },
  tools: [apify.searchActor],
}, async (ctx) => {
  await ctx.step("Find trending repositories", [apify.searchActor], async () => {
    await agent("Find trending GitHub repositories", [apify.searchActor])
  })
})
`

    expect(checkPlaceholderJigPatterns(code)).toEqual([])
  })

  it("accepts a real agent-backed jig even when the agent prompt is long", () => {
    const longPrompt = "Find trending repositories. ".repeat(120)
    const code = `
import { jig, agent } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("github-trends", {
  trigger: { type: "manual" },
  tools: [apify.search_actors, apify.call_actor],
}, async (ctx) => {
  await ctx.step("Find trending repositories", [apify.search_actors, apify.call_actor], async () => {
    await agent(${JSON.stringify(longPrompt)}, [apify.search_actors, apify.call_actor])
  })
})
`

    expect(checkPlaceholderJigPatterns(code)).toEqual([])
  })
})

describe("checkStepToolDeclarations", () => {
  it("rejects a tool used inside a step when it is missing from that step's tools array", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("github-trends", {
  trigger: { type: "manual" },
  tools: [apify.call_actor, apify.get_actor_output],
}, async (ctx) => {
  await ctx.step("Scrape", [apify.call_actor], async () => {
    const result = await apify.call_actor({ actor: "x/y", input: {} })
    const datasetId = (result as any).datasetId
    await apify.get_actor_output({ datasetId })
  })
})
`

    expect(checkStepToolDeclarations(code)).toContainEqual({
      field: "steps.Scrape.apify.get_actor_output",
      message: 'Tool "apify.get_actor_output" is used inside step "Scrape" but is not declared in that step\'s tools array. Add it to that ctx.step() call or move it into a separate step.',
    })
  })

  it("accepts sequential steps that declare their own tools", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("github-trends", {
  trigger: { type: "manual" },
  tools: [apify.call_actor, apify.get_actor_output],
}, async (ctx) => {
  let datasetId = ""
  await ctx.step("Scrape", [apify.call_actor], async () => {
    const result = await apify.call_actor({ actor: "x/y", input: {} })
    datasetId = (result as any).datasetId
  })
  await ctx.step("Fetch", [apify.get_actor_output], async () => {
    await apify.get_actor_output({ datasetId })
  })
})
`

    expect(checkStepToolDeclarations(code)).toEqual([])
  })

  it("accepts named tool arrays used by a step", () => {
    const code = `
import { jig } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace.js"

export default jig("emails", {
  trigger: { type: "manual" },
  tools: [workspace.gmail_search, workspace.gmail_get],
}, async (ctx) => {
  const gatherTools = [workspace.gmail_search, workspace.gmail_get]
  await ctx.step("Gather", gatherTools, async () => {
    await workspace.gmail_search({ query: "weekly update" })
    await workspace.gmail_get({ messageId: "123" })
  })
})
`

    expect(checkStepToolDeclarations(code)).toEqual([])
  })
})

describe("checkPreferCtxEmailForSelfGmail", () => {
  it("rejects gmail_send_email to 'me'", () => {
    const code = `
import { composio } from "@jig/connections/composio.js"

await composio.gmail_send_email({ recipient_email: "me", subject: "hi", body: "x" })
`
    const errors = checkPreferCtxEmailForSelfGmail(code)
    expect(errors).toHaveLength(1)
    expect(errors[0].field).toBe("email.composio.gmail_send_email")
    expect(errors[0].message).toContain("ctx.email")
  })

  it("rejects workspace.gmail_send to 'self'", () => {
    const code = `
import { workspace } from "@jig/connections/workspace.js"

await workspace.gmail_send({ to: "self", subject: "hi", body: "x" })
`
    expect(checkPreferCtxEmailForSelfGmail(code)[0]?.field).toBe("email.workspace.gmail_send")
  })

  it("rejects send to AgentMail owner address when provided", () => {
    const code = `
import { composio } from "@jig/connections/composio.js"

await composio.gmail_send_email({ recipient_email: "owner@example.com", subject: "hi", body: "x" })
`
    const errors = checkPreferCtxEmailForSelfGmail(code, "jig.ts", { ownerEmail: "owner@example.com" })
    expect(errors).toHaveLength(1)
    expect(errors[0].message).toContain("owner@example.com")
  })

  it("allows third-party recipients", () => {
    const code = `
import { composio } from "@jig/connections/composio.js"

await composio.gmail_send_email({ recipient_email: "colleague@example.com", subject: "hi", body: "x" })
`
    expect(checkPreferCtxEmailForSelfGmail(code, "jig.ts", { ownerEmail: "owner@example.com" })).toEqual([])
  })

  it("allows bracket access with the same rule", () => {
    const code = `
import { composio } from "@jig/connections/composio.js"

await composio["gmail_send_email"]({ recipient_email: "me", subject: "hi", body: "x" })
`
    expect(checkPreferCtxEmailForSelfGmail(code)).toHaveLength(1)
  })
})

import { describe, it, expect } from "bun:test"
import { parseStepsFromSource } from "../src/derive-steps"

describe("parseStepsFromSource", () => {
  it("extracts block-scoped steps with tools", () => {
    const code = `
import { jig } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace.js"

export default jig("test", {
  trigger: { type: "manual" },
  tools: [workspace.gmail_search, workspace.gmail_send],
}, async (ctx) => {
  const emails = await ctx.step("Find emails", [
    workspace.gmail_search,
  ], async () => {
    return workspace.gmail_search({ q: "test" })
  })

  await ctx.step("Send reply", [
    workspace.gmail_send,
  ], async () => {
    await workspace.gmail_send({ to: "a@b.com", body: "hi" })
  })
})`
    const steps = parseStepsFromSource(code)
    expect(steps).toHaveLength(2)
    expect(steps[0].num).toBe(1)
    expect(steps[0].name).toBe("Find emails")
    expect(steps[0].tools).toEqual([
      { connection: "workspace", name: "gmail_search", readOnly: true },
    ])
    expect(steps[1].num).toBe(2)
    expect(steps[1].name).toBe("Send reply")
    expect(steps[1].tools).toEqual([
      { connection: "workspace", name: "gmail_send", readOnly: false },
    ])
  })

  it("returns empty for jigs without block-scoped steps", () => {
    const code = `
import { jig } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace.js"

export default jig("test", {
  trigger: { type: "manual" },
  tools: [workspace.gmail_search],
}, async (ctx) => {
  const result = await workspace.gmail_search({ q: "test" })
  ctx.output(result)
})`
    const steps = parseStepsFromSource(code)
    expect(steps).toHaveLength(0)
  })

  it("extracts connections from import statements", () => {
    const code = `
import { workspace } from "@jig/connections/workspace.js"
import { granola } from "@jig/connections/granola.js"

export default jig("test", {
  trigger: { type: "manual" },
  tools: [workspace.gmail_search, granola.get_meetings],
}, async (ctx) => {
  await ctx.step("Gather data", [
    workspace.gmail_search,
    granola.get_meetings,
  ], async () => {})
})`
    const steps = parseStepsFromSource(code)
    expect(steps[0].connections).toEqual(["workspace", "granola"])
  })
})

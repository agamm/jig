import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { analyzeJigFlow } from "../src/domain/jig-flow"
import { renderFlow } from "../src/cli-visualize/render"

const WEEKLY = readFileSync(new URL("../examples/weekly-update.ts", import.meta.url), "utf8")

const SYNTHETIC = `
import { jig, llm, agent } from "@jig/sdk"
import { composio } from "@jig/connections/composio.js"
import { granola } from "@jig/connections/granola.js"

const gather = [granola.list_meetings, granola.get_meeting_transcript]
const PROMPT = \`Summarize for \${"me"}: keep it short\`

export default jig("daily-todo", { trigger: { type: "cron", cron: "0 7 * * 1-5" }, model: "vendor/jig-model", runTimeoutMs: 600000 }, async (ctx) => {
  const who = ctx.params.owner
  const [mail, events] = await ctx.step("Collect", [composio.gmail_fetch_emails, ...gather], async () => {
    return await ctx.parallel([
      composio.gmail_fetch_emails({ query: "is:unread", max_results: 5 }),
      composio.googlecalendar_events_list({ calendarId: "primary" }),
    ])
  })
  const plan = await ctx.step("Decide", [], async () => {
    if (mail.length === 0 && events.length === 0) ctx.skip("nothing to do")
    for (const m of mail) {
      if (m.spam) continue
    }
    try {
      return await llm(PROMPT, { mail, events }, { schema: { items: [{ title: "string" }] }, model: "vendor/fast-model" })
    } catch (e) {
      throw new Error("model failed")
    }
  }, { model: "vendor/step-model" })
  await ctx.step("Send", [], async () => {
    const text = await agent("Write the email", gather)
    await ctx.email({ subject: "Today", text })
    ctx.output(text)
  })
  llm("stray call outside a step")
})
`

describe("analyzeJigFlow", () => {
  it("reads the example jig: trigger, connections, an agent step with its tools and prompt, a code step that emails", () => {
    const flow = analyzeJigFlow(WEEKLY)
    expect(flow.name).toBe("weekly-update")
    expect(flow.triggerRaw).toBe("cron 0 16 * * 5")
    expect(flow.connections).toEqual(["granola"])
    expect(flow.steps.map((s) => [s.seq, s.kind, s.label])).toEqual([
      [1, "ai", "Gather the week and write the update"],
      [2, "code", "Send it for review"],
    ])
    const [gather, send] = flow.steps
    expect(gather.calls).toHaveLength(1)
    expect(gather.calls[0].fn).toBe("agent")
    expect(gather.calls[0].structured).toBe(true)
    expect(gather.calls[0].tools).toEqual(["granola.query_granola_meetings", "granola.list_meetings", "granola.get_meeting_transcript"])
    expect(gather.calls[0].prompt).toContain("Today is ${today}, signed by ${SENDER_NAME}")
    expect(gather.connections).toEqual(["granola"])
    expect(send.emails).toBe(1)
    expect(send.outputs).toBe(1)
    expect(send.connections).toEqual([])
    expect(flow.warnings).toEqual([])
  })

  it("resolves prompts from variables, per-call and per-step models, spread tool arrays, params and control flow", () => {
    const flow = analyzeJigFlow(SYNTHETIC)
    expect(flow.model).toBe("vendor/jig-model")
    expect(flow.runTimeoutMs).toBe(600000)
    expect(flow.params).toEqual(["owner"])
    expect(flow.connections).toEqual(["composio", "granola"])

    const [collect, decide, send] = flow.steps
    expect(collect.kind).toBe("code")
    expect(collect.tools).toEqual(["composio.gmail_fetch_emails", "granola.list_meetings", "granola.get_meeting_transcript", "composio.googlecalendar_events_list"])
    expect(collect.logic.map((l) => l.kind)).toEqual(["parallel"])

    expect(decide.kind).toBe("ai")
    expect(decide.model).toBe("vendor/step-model")
    expect(decide.calls[0].model).toBe("vendor/fast-model")
    expect(decide.calls[0].structured).toBe(true)
    expect(decide.calls[0].promptFrom).toBe("variable")
    expect(decide.calls[0].prompt).toBe('Summarize for ${"me"}: keep it short')
    expect(decide.logic.map((l) => `${l.depth}:${l.kind}`)).toEqual(["0:if", "1:skip", "0:loop", "1:if", "0:try", "0:catch", "1:throw"])
    expect(decide.logic[0].text).toBe("if (mail.length === 0 && events.length === 0)")
    expect(decide.statements.some((s) => s.kind === "skip")).toBe(true)
    expect(decide.statements.find((s) => s.kind === "llm")?.text).toContain("await llm(PROMPT")

    expect(send.calls[0].fn).toBe("agent")
    expect(send.calls[0].tools).toEqual(["granola.list_meetings", "granola.get_meeting_transcript"])
    expect(send.emails).toBe(1)
    expect(flow.warnings).toEqual(["llm() outside any ctx.step() at line 33: it will not be recorded as a step."])
  })

  it("recognizes options passed as the second llm() argument, concatenated prompts, and flags nested steps", () => {
    const flow = analyzeJigFlow(`
import { jig, llm } from "@jig/sdk"
export default jig("x", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("Outer", [], async () => {
    const a = await llm(\`Triage \${"me"}. \` + ("Be brief." + \`Return indexes.\`), { maxTokens: 50, model: "vendor/m" })
    await ctx.step("Inner", [], async () => a)
  })
})`)
    expect(flow.steps).toHaveLength(1)
    expect(flow.steps[0].calls[0].model).toBe("vendor/m")
    expect(flow.steps[0].calls[0].promptFrom).toBe("literal")
    expect(flow.steps[0].calls[0].prompt).toBe('Triage ${"me"}. Be brief.Return indexes.')
    expect(flow.warnings[0]).toContain("Nested ctx.step() at line 6")
  })
})

describe("renderFlow", () => {
  const flow = analyzeJigFlow(SYNTHETIC)

  it("level 1 draws one box per step with its kind, connections and mail, inside the width", () => {
    const text = renderFlow(flow, { level: 1, width: 72 })
    expect(text).toContain("┌─ 1 · code ")
    expect(text).toContain("┌─ 2 · AI · fast-model ")
    expect(text).toContain("│ [composio] [granola]")
    expect(text).toContain("│ [granola] [email]")
    expect(text).toContain("trigger      cron 0 7 * * 1-5")
    expect(text).toContain("timeouts     run 10m")
    expect(text).not.toContain("prompt:")
    expect(text).not.toMatch(/│ llm\(/)
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(72)
  })

  it("level 2 adds the model call, a prompt summary and the notable logic", () => {
    const text = renderFlow(flow, { level: 2, width: 90 })
    expect(text).toContain("llm(fast-model) · structured output · prompt from variable")
    expect(text).toContain('"Summarize for ${"me"}: keep it short"')
    expect(text).toContain("[parallel]")
    expect(text).toContain("[if] if (mail.length === 0 && events.length === 0)")
    expect(text).toContain("[skip]")
    expect(text).not.toContain("logic (every statement)")
    expect(text).toContain("! llm() outside any ctx.step()")
  })

  it("level 3 prints the full prompt with its bar on every line and every statement, tagless when plain", () => {
    const text = renderFlow(flow, { level: 3, width: 60 })
    expect(text).toContain("│   prompt:")
    expect(text).toContain("│   │ Summarize for")
    expect(text).toContain("logic (every statement):")
    expect(text).toContain("· continue")
    expect(text).toContain("[agent] const text = await agent(")
    expect(text).toContain("[email] await ctx.email(")
    for (const line of text.split("\n")) expect(line.length).toBeLessThanOrEqual(60)
  })
})

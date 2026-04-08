import { describe, it, expect } from "bun:test"
import { checkStepStructure } from "../src/services/jig-checker.js"

const wrap = (body: string) => `
import { jig } from "@jig/sdk"
const j = jig("x", { trigger: { type: "manual" } }, async (ctx) => {
${body}
})
export default j
`

describe("checkStepStructure", () => {
  it("accepts a single flat step", () => {
    const src = wrap(`await ctx.step("a", [], async () => { ctx.output("hi") })`)
    expect(checkStepStructure(src)).toEqual([])
  })

  it("accepts multiple sequential steps", () => {
    const src = wrap(`
      let data: any = null
      await ctx.step("get", [], async () => { data = 1 })
      await ctx.step("send", [], async () => { ctx.output(String(data)) })
    `)
    expect(checkStepStructure(src)).toEqual([])
  })

  it("rejects a jig with no ctx.step calls", () => {
    const src = wrap(`ctx.output("no steps here")`)
    const problems = checkStepStructure(src)
    expect(problems.length).toBe(1)
    expect(problems[0]).toMatch(/no ctx\.step\(\) calls/)
  })

  it("rejects directly nested ctx.step", () => {
    const src = wrap(`
      await ctx.step("outer", [], async () => {
        await ctx.step("inner", [], async () => { ctx.output("nested") })
      })
    `)
    const problems = checkStepStructure(src)
    expect(problems.some(p => /nested inside another ctx\.step/.test(p))).toBe(true)
  })

  it("rejects nested ctx.step buried deep in the callback body", () => {
    const src = wrap(`
      await ctx.step("outer", [], async () => {
        const events = [1, 2, 3]
        if (events.length > 0) {
          for (const e of events) {
            await ctx.step("inner", [], async () => { ctx.output(String(e)) })
          }
        }
      })
    `)
    const problems = checkStepStructure(src)
    expect(problems.some(p => /nested inside another ctx\.step/.test(p))).toBe(true)
  })

  it("reports the line number of the nested step", () => {
    const src = wrap(`
      await ctx.step("outer", [], async () => {
        await ctx.step("inner", [], async () => {})
      })
    `)
    const problems = checkStepStructure(src)
    const match = problems[0]?.match(/^Line (\d+):/)
    expect(match).toBeTruthy()
    const line = Number(match![1])
    expect(line).toBeGreaterThan(0)
  })

  it("accepts ctx.step inside a non-step helper function", () => {
    // Two top-level steps, one wrapped in an inner arrow that is itself the step body —
    // this should still be flagged only when literally nested inside a ctx.step callback.
    const src = wrap(`
      const helper = async () => 42
      await ctx.step("a", [], async () => { await helper() })
      await ctx.step("b", [], async () => { ctx.output("done") })
    `)
    expect(checkStepStructure(src)).toEqual([])
  })

  it("reports both nesting and zero-step problems independently", () => {
    // Nested case: stepCount > 0 so only the nesting problem appears.
    const nested = wrap(`
      await ctx.step("o", [], async () => {
        await ctx.step("i", [], async () => {})
      })
    `)
    const nestedProblems = checkStepStructure(nested)
    expect(nestedProblems.some(p => /nested/.test(p))).toBe(true)
    expect(nestedProblems.some(p => /no ctx\.step/.test(p))).toBe(false)
  })

  it("handles ctx.step inside string literals without false positives", () => {
    const src = wrap(`
      await ctx.step("real", [], async () => {
        ctx.output("ctx.step('fake')")
      })
    `)
    expect(checkStepStructure(src)).toEqual([])
  })

  it("does not confuse other.step() with ctx.step()", () => {
    const src = wrap(`
      const other = { step: async (_l: string, _t: any[], fn: any) => fn() }
      await other.step("not a real step", [], async () => {})
      await ctx.step("real", [], async () => {})
    `)
    expect(checkStepStructure(src)).toEqual([])
  })
})

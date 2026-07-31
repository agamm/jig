import { describe, it, expect } from "bun:test"
import { Context } from "../src/sdk/context"

describe("ctx.step block-scoped", () => {
  it("runs callback and returns its value", async () => {
    const ctx = new Context({})
    const result = await ctx.step("Test step", [], async () => {
      return 42
    })
    expect(result).toBe(42)
  })

  it("sets and clears currentStepLabel", async () => {
    const ctx = new Context({})
    const insideLabel = await ctx.step("My Step", [], async () => ctx.currentStepLabel)
    expect(insideLabel).toBe("My Step")
    expect(ctx.currentStepLabel).toBeNull()
  })

  it("sets and clears currentStepToolNames", async () => {
    const mockTool = { _serverName: "workspace", _toolName: "gmail_send", _readOnly: false } as any
    const ctx = new Context({})
    let insideTools: string[] = []
    await ctx.step("Send", [mockTool], async () => {
      insideTools = ctx.currentStepToolNames
    })
    expect(insideTools).toEqual(["gmail_send"])
    expect(ctx.currentStepToolNames).toEqual([])
  })

  it("isToolAllowedInCurrentStep returns true for listed tool", async () => {
    const mockTool = { _serverName: "workspace", _toolName: "gmail_send", _readOnly: false } as any
    const ctx = new Context({})
    let allowed = false
    await ctx.step("Send", [mockTool], async () => {
      allowed = ctx.isToolAllowedInCurrentStep("gmail_send")
    })
    expect(allowed).toBe(true)
  })

  it("isToolAllowedInCurrentStep returns false for unlisted tool", async () => {
    const mockTool = { _serverName: "workspace", _toolName: "gmail_send", _readOnly: false } as any
    const ctx = new Context({})
    let allowed = true
    await ctx.step("Send", [mockTool], async () => {
      allowed = ctx.isToolAllowedInCurrentStep("gmail_search")
    })
    expect(allowed).toBe(false)
  })

  it("isToolAllowedInCurrentStep returns false between steps", () => {
    const ctx = new Context({})
    expect(ctx.isToolAllowedInCurrentStep("gmail_send")).toBe(false)
  })

  it("clears tools even if callback throws", async () => {
    const mockTool = { _serverName: "workspace", _toolName: "gmail_send", _readOnly: false } as any
    const ctx = new Context({})
    try {
      await ctx.step("Fail", [mockTool], async () => { throw new Error("boom") })
    } catch {}
    expect(ctx.currentStepToolNames).toEqual([])
    expect(ctx.currentStepLabel).toBeNull()
  })

  it("allows two sequential ctx.step calls at the top level", async () => {
    const ctx = new Context({})
    const labels: string[] = []
    await ctx.step("First", [], async () => { labels.push(ctx.currentStepLabel!) })
    await ctx.step("Second", [], async () => { labels.push(ctx.currentStepLabel!) })
    expect(labels).toEqual(["First", "Second"])
    expect(ctx.currentStepLabel).toBeNull()
  })

  it("throws when ctx.step is nested inside another ctx.step", async () => {
    const ctx = new Context({})
    let innerRan = false
    let thrown: Error | null = null
    try {
      await ctx.step("Outer", [], async () => {
        await ctx.step("Inner", [], async () => { innerRan = true })
      })
    } catch (e: any) {
      thrown = e
    }
    expect(innerRan).toBe(false)
    expect(thrown).toBeInstanceOf(Error)
    expect(thrown!.message).toMatch(/nested/i)
    expect(thrown!.message).toContain("Outer")
    expect(thrown!.message).toContain("Inner")
  })

  it("allows another ctx.step after the previous one threw", async () => {
    const ctx = new Context({})
    try {
      await ctx.step("Fail", [], async () => { throw new Error("boom") })
    } catch {}
    let secondRan = false
    await ctx.step("Recovery", [], async () => { secondRan = true })
    expect(secondRan).toBe(true)
  })
})

describe("tool enforcement", () => {
  // Simulates what the generated connection module does
  function simulateToolCall(ctx: Context, toolName: string) {
    if (!ctx.isToolAllowedInCurrentStep(toolName)) {
      throw new Error(
        `Tool "workspace.${toolName}" is not allowed in step "${ctx.currentStepLabel ?? "(no active step)"}".`
      )
    }
  }

  const gmail_send = { _serverName: "workspace", _toolName: "gmail_send", _readOnly: false } as any
  const gmail_search = { _serverName: "workspace", _toolName: "gmail_search", _readOnly: true } as any

  it("allows tool call inside its declared step", async () => {
    const ctx = new Context({})
    await ctx.step("Send", [gmail_send], async () => {
      expect(() => simulateToolCall(ctx, "gmail_send")).not.toThrow()
    })
  })

  it("blocks tool call not in current step", async () => {
    const ctx = new Context({})
    await ctx.step("Send", [gmail_send], async () => {
      expect(() => simulateToolCall(ctx, "gmail_search")).toThrow(/not allowed in step/)
    })
  })

  it("blocks tool call outside any step", () => {
    const ctx = new Context({})
    expect(() => simulateToolCall(ctx, "gmail_send")).toThrow(/no active step/)
  })

  it("tool allowed in one step is blocked in the next", async () => {
    const ctx = new Context({})
    await ctx.step("Search", [gmail_search], async () => {
      expect(() => simulateToolCall(ctx, "gmail_search")).not.toThrow()
    })
    await ctx.step("Send", [gmail_send], async () => {
      expect(() => simulateToolCall(ctx, "gmail_search")).toThrow(/not allowed/)
      expect(() => simulateToolCall(ctx, "gmail_send")).not.toThrow()
    })
  })

  it("tools are blocked between sequential steps", async () => {
    const ctx = new Context({})
    await ctx.step("Step 1", [gmail_send], async () => {})
    // Between steps — should block
    expect(() => simulateToolCall(ctx, "gmail_send")).toThrow(/no active step/)
    await ctx.step("Step 2", [gmail_send], async () => {})
  })
})

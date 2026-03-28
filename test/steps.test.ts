import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { truncLabel, runContext, stepScanContext, Context } from "../src/sdk/context.js"
import { jig, scanSteps } from "../src/sdk/jig.js"
import type { JigTool } from "../src/sdk/jig.js"
import { openDb, closeDb, getStepCache, setStepCache } from "../src/db.js"

// --- truncLabel ---

describe("truncLabel", () => {
  it("returns short strings as-is", () => {
    expect(truncLabel("Search inbox")).toBe("Search inbox")
  })

  it("trims whitespace", () => {
    expect(truncLabel("  hello  ")).toBe("hello")
  })

  it("truncates long strings without ellipsis", () => {
    const long = "A".repeat(80)
    const result = truncLabel(long)
    expect(result.length).toBe(60)
    expect(result).toBe("A".repeat(60))
  })

  it("does not truncate at exactly max length", () => {
    const exact = "A".repeat(60)
    expect(truncLabel(exact)).toBe(exact)
  })

  it("respects custom max", () => {
    expect(truncLabel("Hello World", 5)).toBe("Hello")
  })
})

// --- scanSteps ---

function mockTool(serverName: string, toolName: string): JigTool<any, any> {
  const fn = async (_params: any) => {
    // In scan mode, this would be intercepted by the generated wrapper.
    // For testing, simulate what the wrapper does:
    const ctx = runContext.getStore()
    if (ctx && !ctx.inAgent) ctx.step(`${serverName}.${toolName}`)
    ctx?.addConnection(serverName)
    return {} as any
  }
  fn._serverName = serverName
  fn._toolName = toolName
  fn._readOnly = false
  return fn as JigTool<any, any>
}

describe("scanSteps", () => {
  it("collects steps from direct tool calls", async () => {
    const tool1 = mockTool("workspace", "gmail_search")
    const tool2 = mockTool("workspace", "gmail_createDraft")

    const def = jig("test", { trigger: { type: "manual" }, tools: [tool1, tool2] }, async (ctx) => {
      await tool1({ query: "test" })
      await tool2({ to: "a@b.com", body: "hi" })
    })

    const steps = await scanSteps(def)
    expect(steps).toHaveLength(2)
    expect(steps[0].label).toBe("workspace.gmail_search")
    expect(steps[0].connections).toEqual(["workspace"])
    expect(steps[1].label).toBe("workspace.gmail_createDraft")
  })

  it("collects steps from manual ctx.step calls", async () => {
    const def = jig("test", { trigger: { type: "manual" } }, async (ctx) => {
      ctx.step("Fetch data")
      ctx.step("Process data")
    })

    const steps = await scanSteps(def)
    expect(steps).toHaveLength(2)
    expect(steps[0].label).toBe("Fetch data")
    expect(steps[1].label).toBe("Process data")
  })

  it("returns partial steps if handler crashes on stub values", async () => {
    const tool1 = mockTool("granola", "list_meetings")

    const def = jig("test", { trigger: { type: "manual" }, tools: [tool1] }, async (ctx) => {
      const result = await tool1({})
      ctx.step("Process")
      // This would crash if result is a stub: result.meetings.map(...)
      const meetings = (result as any).meetings
      if (meetings) meetings.map(() => {}) // crash on stub
    })

    const steps = await scanSteps(def)
    // Should get at least the tool step and "Process" step before the crash
    expect(steps.length).toBeGreaterThanOrEqual(2)
    expect(steps[0].label).toBe("granola.list_meetings")
  })

  it("returns empty array for handler that fails before any step", async () => {
    const def = jig("test", { trigger: { type: "manual" } }, async (_ctx) => {
      throw new Error("Immediate failure")
    })

    const steps = await scanSteps(def)
    expect(steps).toHaveLength(0)
  })

  it("tracks connections from multiple tools in one step", async () => {
    const tool1 = mockTool("workspace", "gmail_search")
    const tool2 = mockTool("granola", "list_meetings")

    // Simulate an agent-like step where multiple connections are used
    const def = jig("test", { trigger: { type: "manual" }, tools: [tool1, tool2] }, async (ctx) => {
      ctx.step("Gather data")
      ctx.addConnection("workspace")
      ctx.addConnection("granola")
      ctx.addConnection("workspace") // duplicate — should dedupe
    })

    const steps = await scanSteps(def)
    expect(steps).toHaveLength(1)
    expect(steps[0].connections).toEqual(["workspace", "granola"])
  })
})

// --- step_cache ---

describe("step_cache", () => {
  beforeEach(() => {
    closeDb()
    openDb(":memory:")
  })

  afterEach(() => {
    closeDb()
  })

  it("returns null on cache miss", () => {
    expect(getStepCache("test-jig", null, "abc123")).toBeNull()
  })

  it("round-trips cache data", () => {
    const steps = [
      { num: 1, name: "Gather data", connections: ["granola", "workspace"] },
      { num: 2, name: "Create draft", connections: ["workspace"] },
    ]
    setStepCache("test-jig", null, "abc123", steps)
    const result = getStepCache("test-jig", null, "abc123")
    expect(result).toEqual(steps)
  })

  it("returns null on hash mismatch", () => {
    setStepCache("test-jig", null, "hash1", [{ num: 1, name: "A", connections: [] }])
    expect(getStepCache("test-jig", null, "hash2")).toBeNull()
  })

  it("replaces cache on new hash for same jig", () => {
    setStepCache("test-jig", null, "hash1", [{ num: 1, name: "Old", connections: [] }])
    setStepCache("test-jig", null, "hash2", [{ num: 1, name: "New", connections: [] }])
    expect(getStepCache("test-jig", null, "hash1")).toBeNull()
    expect(getStepCache("test-jig", null, "hash2")![0].name).toBe("New")
  })

  it("handles entity-scoped caching", () => {
    setStepCache("invoice", "acme", "h1", [{ num: 1, name: "A", connections: [] }])
    setStepCache("invoice", "globex", "h2", [{ num: 1, name: "B", connections: [] }])
    expect(getStepCache("invoice", "acme", "h1")![0].name).toBe("A")
    expect(getStepCache("invoice", "globex", "h2")![0].name).toBe("B")
    expect(getStepCache("invoice", null, "h1")).toBeNull()
  })
})

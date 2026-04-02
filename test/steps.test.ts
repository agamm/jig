import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { truncLabel, Context } from "../src/sdk/context.js"
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

// --- ctx.step block-scoped enforcement ---

describe("ctx.step", () => {
  it("enforces tool allowlist within a step", async () => {
    const ctx = new Context({}, [])
    const steps: string[] = []
    ctx.setRecorder({
      onStepStart(_seq, label) { steps.push(label) },
      onStepDone() {},
    })

    await ctx.step("Allowed step", [], async () => {
      // No tools called — should succeed
    })

    expect(steps).toEqual(["Allowed step"])
  })

  it("isToolAllowedInCurrentStep returns false outside a step", () => {
    const ctx = new Context({}, [])
    expect(ctx.isToolAllowedInCurrentStep("gmail_search")).toBe(false)
  })

  it("isToolAllowedInCurrentStep returns false for undeclared tools inside a step", async () => {
    const ctx = new Context({}, [])
    let checkedInside = false
    await ctx.step("Step", [], async () => {
      checkedInside = true
      expect(ctx.isToolAllowedInCurrentStep("gmail_search")).toBe(false)
    })
    expect(checkedInside).toBe(true)
  })

  it("currentStepLabel is null between steps", async () => {
    const ctx = new Context({}, [])
    expect(ctx.currentStepLabel).toBeNull()
    await ctx.step("My step", [], async () => {
      expect(ctx.currentStepLabel).toBe("My step")
    })
    expect(ctx.currentStepLabel).toBeNull()
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
    expect(getStepCache("test-jig", "abc123")).toBeNull()
  })

  it("round-trips cache data", () => {
    const steps = [
      { num: 1, name: "Gather data", connections: ["granola", "workspace"] },
      { num: 2, name: "Create draft", connections: ["workspace"] },
    ]
    setStepCache("test-jig", "abc123", steps)
    const result = getStepCache("test-jig", "abc123")
    expect(result).toEqual(steps)
  })

  it("returns null on hash mismatch", () => {
    setStepCache("test-jig", "hash1", [{ num: 1, name: "A", connections: [] }])
    expect(getStepCache("test-jig", "hash2")).toBeNull()
  })

  it("replaces cache on new hash for same jig", () => {
    setStepCache("test-jig", "hash1", [{ num: 1, name: "Old", connections: [] }])
    setStepCache("test-jig", "hash2", [{ num: 1, name: "New", connections: [] }])
    expect(getStepCache("test-jig", "hash1")).toBeNull()
    expect(getStepCache("test-jig", "hash2")![0].name).toBe("New")
  })
})

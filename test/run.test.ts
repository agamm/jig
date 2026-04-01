/**
 * Run execution — tests the runner's event lifecycle, dry-run behavior,
 * and validation guards. No LLM calls: uses jigs that don't call ctx.llm().
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { writeFileSync, rmSync } from "fs"
import { join } from "path"
import type { RunEvent } from "../src/run-events.js"

const PROJECT_ROOT = join(import.meta.dir, "..")
const JIGS_DIR = join(PROJECT_ROOT, "jigs")

// Initialize in-memory DB once
let dbInit = false
async function ensureDb() {
  if (dbInit) return
  const { openDb } = await import("../src/db.js")
  openDb(":memory:")
  dbInit = true
}

describe("run lifecycle events", () => {
  const testJigPath = join(JIGS_DIR, "_test_run_events.ts")

  beforeEach(async () => { await ensureDb() })
  afterEach(() => { rmSync(testJigPath, { force: true }) })

  it("emits step-start, step-done, done for a simple jig", async () => {
    const { runJig } = await import("../src/runner.js")
    writeFileSync(testJigPath, `
import { jig } from "jig"

export default jig("test-events", {
  trigger: { type: "manual" },
  connections: [],
}, async (ctx) => {
  ctx.step("Step one")
  ctx.output("hello world")
})
`)
    const events: RunEvent[] = []
    const result = await runJig(testJigPath, {}, (e) => events.push(e), { dryRun: true, silent: true })

    expect(result.error).toBeUndefined()
    expect(result.output).toContain("hello world")

    const types = events.map(e => e.type)
    expect(types).toContain("step-start")
    expect(types).toContain("step-done")
    expect(types).toContain("done")

    const stepStart = events.find(e => e.type === "step-start")!
    expect(stepStart).toHaveProperty("label", "Step one")
  })

  it("emits multiple step events in order", async () => {
    const { runJig } = await import("../src/runner.js")
    writeFileSync(testJigPath, `
import { jig } from "jig"

export default jig("test-multi-step", {
  trigger: { type: "manual" },
  connections: [],
}, async (ctx) => {
  ctx.step("Gather data")
  ctx.step("Process data")
  ctx.output("processed")
})
`)
    const events: RunEvent[] = []
    await runJig(testJigPath, {}, (e) => events.push(e), { dryRun: true, silent: true })

    const stepStarts = events.filter(e => e.type === "step-start")
    expect(stepStarts.length).toBe(2)
    expect((stepStarts[0] as any).label).toBe("Gather data")
    expect((stepStarts[1] as any).label).toBe("Process data")

    const stepDones = events.filter(e => e.type === "step-done")
    expect(stepDones.length).toBe(2)
  })

  it("emits error event when handler throws", async () => {
    const { runJig } = await import("../src/runner.js")
    // Use unique filename to avoid Bun import cache collisions across test files
    const throwJigPath = join(JIGS_DIR, "_test_run_throw.ts")
    writeFileSync(throwJigPath, `
import { jig } from "jig"

export default jig("test-throw", {
  trigger: { type: "manual" },
  connections: [],
}, async (ctx) => {
  ctx.step("Will fail")
  throw new Error("something broke")
})
`)
    try {
      const events: RunEvent[] = []
      const result = await runJig(throwJigPath, {}, (e) => events.push(e), { dryRun: true, silent: true })

      expect(result.error).toBe("something broke")
      expect(result.output).toBe("")

      const types = events.map(e => e.type)
      expect(types).toContain("step-start")
      expect(types).toContain("error")
      expect(types).not.toContain("done")
    } finally {
      rmSync(throwJigPath, { force: true })
    }
  })
})

describe("run validation guards", () => {
  const testJigPath = join(JIGS_DIR, "_test_run_guard.ts")

  beforeEach(async () => { await ensureDb() })
  afterEach(() => { rmSync(testJigPath, { force: true }) })

  it("rejects jig with missing required params", async () => {
    const { runJig } = await import("../src/runner.js")
    writeFileSync(testJigPath, `
import { jig } from "jig"

export default jig("test-params", {
  trigger: { type: "manual" },
  connections: [],
  params: { name: "Your name" },
}, async (ctx) => {
  ctx.output(ctx.params.name)
})
`)
    const events: RunEvent[] = []
    const result = await runJig(testJigPath, {}, (e) => events.push(e), { dryRun: true, silent: true })

    expect(result.error).toContain("Missing required params")
    expect(result.error).toContain("name")
  })

  it("passes when required params are provided", async () => {
    const { runJig } = await import("../src/runner.js")
    writeFileSync(testJigPath, `
import { jig } from "jig"

export default jig("test-params-ok", {
  trigger: { type: "manual" },
  connections: [],
  params: { name: "Your name" },
}, async (ctx) => {
  ctx.output("Hello " + ctx.params.name)
})
`)
    const events: RunEvent[] = []
    const result = await runJig(testJigPath, { name: "Alice" }, (e) => events.push(e), { dryRun: true, silent: true })

    expect(result.error).toBeUndefined()
    expect(result.output).toContain("Alice")
  })

  it("rejects jig without default export", async () => {
    const { runJig } = await import("../src/runner.js")
    writeFileSync(testJigPath, `export const foo = "bar"`)

    const events: RunEvent[] = []
    const result = await runJig(testJigPath, {}, (e) => events.push(e), { dryRun: true, silent: true })

    expect(result.error).toBeDefined()
    expect(events.some(e => e.type === "error")).toBe(true)
  })

  it("rejects nonexistent jig file", async () => {
    const { runJig } = await import("../src/runner.js")

    const events: RunEvent[] = []
    const result = await runJig("/nonexistent/jig.ts", {}, (e) => events.push(e), { dryRun: true, silent: true })

    expect(result.error).toBeDefined()
    expect(events.some(e => e.type === "error")).toBe(true)
  })
})

describe("dry-run flag propagation", () => {
  it("dryRun context is set during run", async () => {
    const testJigPath = join(JIGS_DIR, "_test_dryrun_ctx.ts")
    try {
      const { runJig } = await import("../src/runner.js")
      await ensureDb()

      writeFileSync(testJigPath, `
import { jig } from "jig"
import { isDryRun } from "jig/sdk/dryrun.js"

export default jig("test-dryrun", {
  trigger: { type: "manual" },
  connections: [],
}, async (ctx) => {
  ctx.output(isDryRun() ? "dry" : "live")
})
`)
      const result = await runJig(testJigPath, {}, () => {}, { dryRun: true, silent: true })
      expect(result.output).toContain("dry")

    } finally {
      rmSync(testJigPath, { force: true })
    }
  })
})

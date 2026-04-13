import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import type { RunEvent } from "../src/run-events.js"

const PROJECT_ROOT = join(import.meta.dir, "..")

// Tests write ephemeral jig files into an OS temp dir — never the project's jigs/.
const TEST_TMP_DIR = mkdtempSync(join(tmpdir(), "jig-runner-test-"))

describe("runner", () => {
  it("emits error for jig without default export", async () => {
    const { runJig } = await import("../src/runner.js")
    const { openDb } = await import("../src/db.js")
    openDb(":memory:")

    const testJig = join(TEST_TMP_DIR, "no-default.ts")
    writeFileSync(testJig, 'export const foo = "bar"')
    try {
      const events: RunEvent[] = []
      const result = await runJig(testJig, {}, (e) => events.push(e), { dryRun: true, silent: true })
      expect(result.error).toBeDefined()
      expect(events.some(e => e.type === "error")).toBe(true)
    } finally {
      rmSync(testJig, { force: true })
    }
  })

  it("rejects jig with top-level run() call", async () => {
    const { runJig } = await import("../src/runner.js")
    const testJig = join(TEST_TMP_DIR, "bad-run.ts")
    writeFileSync(testJig, `import { jig, run } from "${PROJECT_ROOT}/src/index.js"\nconst j = jig("x", { trigger: { type: "manual" } }, async () => {})\nawait run(j)\nprocess.exit(0)`)
    try {
      const events: RunEvent[] = []
      const result = await runJig(testJig, {}, (e) => events.push(e), { dryRun: true, silent: true })
      expect(result.error).toContain("run() at module level")
    } finally {
      rmSync(testJig, { force: true })
    }
  })

  it("rejects jig with console.log", async () => {
    const { runJig } = await import("../src/runner.js")
    const testJig = join(TEST_TMP_DIR, "bad-console.ts")
    writeFileSync(testJig, `import { jig } from "${PROJECT_ROOT}/src/index.js"\nexport default jig("x", { trigger: { type: "manual" } }, async (ctx) => { console.log("bad") })`)
    try {
      const events: RunEvent[] = []
      const result = await runJig(testJig, {}, (e) => events.push(e), { dryRun: true, silent: true })
      expect(result.error).toContain("ctx.output()")
    } finally {
      rmSync(testJig, { force: true })
    }
  })

  it("does not reject string literals that merely mention console.log()", async () => {
    const { runJig } = await import("../src/runner.js")
    const testJig = join(TEST_TMP_DIR, "console-string.ts")
    writeFileSync(testJig, `import { jig } from "${PROJECT_ROOT}/src/index.js"\nexport default jig("x", { trigger: { type: "manual" } }, async (ctx) => { await ctx.step("ok", [], async () => { ctx.output("Mention console.log() in docs only") }) })`)
    try {
      const events: RunEvent[] = []
      const result = await runJig(testJig, {}, (e) => events.push(e), { dryRun: true, silent: true })
      expect(result.error).toBeUndefined()
      expect(events.some(e => e.type === "done")).toBe(true)
    } finally {
      rmSync(testJig, { force: true })
    }
  })

  it("emits error for nonexistent jig file", async () => {
    const { runJig } = await import("../src/runner.js")
    const { openDb } = await import("../src/db.js")
    openDb(":memory:")

    const events: RunEvent[] = []
    const result = await runJig("/nonexistent/jig.ts", {}, (e) => events.push(e), { dryRun: true, silent: true })
    expect(result.error).toBeDefined()
    expect(events.some(e => e.type === "error")).toBe(true)
  })
})

describe("start preflight", () => {
  it("detects stale connection files", () => {
    const connectionsDir = join(PROJECT_ROOT, ".jig/connections")
    if (!existsSync(connectionsDir)) return // skip if no connections

    const files = Bun.spawnSync(["ls", connectionsDir]).stdout.toString().split("\n").filter(f => f.endsWith(".ts") && f !== "index.ts")
    for (const file of files) {
      const content = readFileSync(join(connectionsDir, file), "utf-8")
      expect(content).not.toContain("sdk/connections") // stale import pattern
    }
  })
})

describe("index exports", () => {
  it("exports run function", async () => {
    const mod = await import("../src/index.js")
    expect(typeof mod.run).toBe("function")
  })

  it("exports jig function", async () => {
    const mod = await import("../src/index.js")
    expect(typeof mod.jig).toBe("function")
  })

  it("exports llm function", async () => {
    const mod = await import("../src/index.js")
    expect(typeof mod.llm).toBe("function")
  })

  it("exports agent function", async () => {
    const mod = await import("../src/index.js")
    expect(typeof mod.agent).toBe("function")
  })
})

describe("dryrun flag", () => {
  it("setDryRun(false) clears env var", async () => {
    const { setDryRun, isDryRun } = await import("../src/sdk/dryrun.js")
    setDryRun(true)
    expect(isDryRun()).toBe(true)
    expect(process.env.JIG_DRY_RUN).toBe("1")

    setDryRun(false)
    expect(isDryRun()).toBe(false)
    expect(process.env.JIG_DRY_RUN).toBeUndefined()
  })
})

describe("formatDuration", () => {
  it("formats seconds", async () => {
    const { formatDuration } = await import("../src/utils.js")
    expect(formatDuration(5000)).toBe("5.0s")
    expect(formatDuration(45200)).toBe("45.2s")
  })

  it("formats minutes", async () => {
    const { formatDuration } = await import("../src/utils.js")
    expect(formatDuration(72000)).toBe("1m 12s")
    expect(formatDuration(120000)).toBe("2m")
  })

  it("formats hours", async () => {
    const { formatDuration } = await import("../src/utils.js")
    expect(formatDuration(3660000)).toBe("1h 1m")
    expect(formatDuration(7200000)).toBe("2h")
  })
})

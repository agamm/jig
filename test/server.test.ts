import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "fs"
import { join } from "path"

const PROJECT_ROOT = join(import.meta.dir, "..")

describe("run-worker", () => {
  it("emits error for invalid params JSON", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/run-worker.ts", "jigs/weekly-update.ts", "--params", "not-json"],
      { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toContain('"type":"error"')
    expect(out).toContain("Invalid params JSON")
  })

  it("emits error for missing jig path", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/run-worker.ts"],
      { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toContain('"type":"error"')
    expect(out).toContain("No jig path")
  })

  it("emits error for jig without default export", async () => {
    const testJig = join(PROJECT_ROOT, "jigs/_test_no_default.ts")
    writeFileSync(testJig, 'export const foo = "bar"')
    try {
      const proc = Bun.spawn(
        ["bun", "run", "src/run-worker.ts", testJig],
        { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
      )
      const out = await new Response(proc.stdout).text()
      await proc.exited
      expect(out).toContain('"type":"error"')
      expect(out).toContain("default")
    } finally {
      rmSync(testJig, { force: true })
    }
  })

  it("emits error for nonexistent jig file", async () => {
    const proc = Bun.spawn(
      ["bun", "run", "src/run-worker.ts", "/nonexistent/jig.ts"],
      { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" }
    )
    const out = await new Response(proc.stdout).text()
    await proc.exited
    expect(out).toContain('"type":"error"')
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

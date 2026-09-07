/**
 * The failure log (GET /api/failures, `jig debug failures`): derived from
 * runs and run_steps, newest first, each entry classified with a remedy.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, completeRun, completeStep, insertRun, insertStep, openDb } from "../src/db.js"
import { buildFailureLog } from "../src/services/failures.js"
import { collapse, renderFailureLog } from "../src/cli-debug/failures-render.js"
import { matchRoute } from "../src/server/router.js"
import type { FailureEntry, FailureLog } from "../shared/api.js"
import { seedJig } from "./_fixtures.js"

const JIG = "log-jig"
const OTHER = "log-other"

function source(id: string): string {
  return `
import { jig } from "@jig/sdk"
import { linear } from "@jig/connections/linear"

export default jig("${id}", { trigger: { type: "cron", cron: "0 9 * * *" } }, async (ctx) => {
  await ctx.step("fetch", [linear.list_issues], async () => {})
})
`
}

function seedRun(jigId: string, opts: { status?: "success" | "fail"; error?: string; stepError?: string; startedAt?: string; connections?: string[] } = {}): number {
  const status = opts.status ?? "fail"
  const runId = insertRun(jigId)
  const step = insertStep(runId, 1, "fetch")
  if (status === "fail" && opts.stepError) completeStep(step, "", "fail", 300, opts.connections ?? ["linear"], opts.stepError)
  else completeStep(step, "ok", "success", 300, opts.connections ?? ["linear"])
  completeRun(runId, status, 1500, status === "fail" ? opts.error ?? "boom" : undefined)
  if (opts.startedAt) openDb().prepare(`UPDATE runs SET started_at = ? WHERE id = ?`).run(opts.startedAt, runId)
  return runId
}

const HOUR = 60 * 60 * 1000
function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ")
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  seedJig(JIG, source(JIG))
  seedJig(OTHER, source(OTHER))
})
afterEach(() => closeDb())

describe("buildFailureLog", () => {
  it("lists failed runs newest first with the step's own error classified", () => {
    seedRun(JIG, { stepError: "401 Unauthorized" })
    const second = seedRun(JIG, { error: "Run timed out after 10 minutes" })
    seedRun(JIG, { status: "success" })

    const log = buildFailureLog({ since: new Date(Date.now() - HOUR) })
    expect(log.failures.map((f) => f.runId)[0]).toBe(second)
    expect(log.failures).toHaveLength(2)
    const [timeout, auth] = log.failures
    expect(timeout).toMatchObject({ jigId: JIG, cause: "timeout", step: null, error: "Run timed out after 10 minutes" })
    expect(auth).toMatchObject({ jigId: JIG, cause: "auth", step: { seq: 1, label: "fetch" }, connections: ["linear"] })
    expect(auth.remedy).toContain("bun run jig connect linear")
    expect(log.truncated).toBe(false)
  })

  it("falls back to the jig's declared connections when the failing step recorded none", () => {
    seedRun(JIG, { stepError: "invalid_grant", connections: [] })
    const [entry] = buildFailureLog({ since: new Date(Date.now() - HOUR) }).failures
    expect(entry.connections).toEqual(["linear"])
    expect(entry.remedy).toContain("bun run jig connect linear")
  })

  it("honours the window and the jig filter, and leaves cancellations out", () => {
    seedRun(JIG, { error: "old", startedAt: sqliteTime(Date.now() - 3 * HOUR) })
    seedRun(JIG, { error: "recent" })
    seedRun(OTHER, { error: "elsewhere" })
    seedRun(JIG, { error: "Cancelled by user" })

    const all = buildFailureLog({ since: new Date(Date.now() - HOUR) })
    expect(all.failures.map((f) => f.error)).toEqual(["elsewhere", "recent"])
    const one = buildFailureLog({ since: new Date(Date.now() - HOUR), jigId: OTHER })
    expect(one.failures.map((f) => f.jigId)).toEqual([OTHER])
    const wide = buildFailureLog({ since: new Date(Date.now() - 4 * HOUR), jigId: JIG })
    expect(wide.failures.map((f) => f.error)).toEqual(["recent", "old"])
  })

  it("reports when the window was cut by the limit", () => {
    for (let i = 0; i < 3; i++) seedRun(JIG, { error: `f${i}` })
    const log = buildFailureLog({ since: new Date(Date.now() - HOUR), limit: 2 })
    expect(log.failures).toHaveLength(2)
    expect(log.truncated).toBe(true)
  })

  it("is routed at /api/failures", () => {
    expect(matchRoute("/api/failures")?.handler).toBe("failures")
  })
})

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function entry(over: Partial<FailureEntry> = {}): FailureEntry {
  return {
    runId: 1,
    jigId: "post-meeting-coach",
    at: "2026-09-06T14:02:00.000Z",
    step: { seq: 2, label: "fetch transcript" },
    error: "composio: response was too large to return inline (~24000 tokens) and was spilled to /mnt/files/a.json",
    cause: "composio-spill",
    remedy: "Connect the service's own MCP server (bun run jig connect <service>)",
    connections: ["composio"],
    ...over,
  }
}

describe("renderFailureLog", () => {
  const target = { handle: "prod", url: "https://jig.example.com", since: "7d" }

  it("collapses a repeating failure into one entry with its count and span", () => {
    const log: FailureLog = {
      generatedAt: "2026-09-07T00:00:00.000Z",
      since: "2026-08-31T00:00:00.000Z",
      failures: [
        entry({ runId: 30, at: "2026-09-06T14:02:00.000Z" }),
        entry({ runId: 29, at: "2026-09-06T13:02:00.000Z" }),
        entry({ runId: 28, at: "2026-09-06T12:02:00.000Z" }),
        entry({ runId: 27, jigId: "daily-digest", at: "2026-09-05T09:00:00.000Z", step: null, error: "429 Rate limit exceeded", cause: "rate-limit", remedy: "Rerun later." }),
      ],
      truncated: false,
    }
    const lines = renderFailureLog(log, target).split("\n")
    expect(lines[0]).toBe("prod (https://jig.example.com)  ·  since 7d  ·  4 failures across 2 jigs")
    expect(lines[2]).toMatch(/^2026-09-06 14:02Z  x3 since 2026-09-06 12:02Z  post-meeting-coach\s+composio-spill\s+run #30 step 2 "fetch transcript"$/)
    expect(lines[3]).toBe("    composio: response was too large to return inline (~24000 tokens) and was spilled to /mnt/files/a.json")
    expect(lines[4]).toBe("    -> Connect the service's own MCP server (bun run jig connect <service>)")
    expect(lines[6]).toMatch(/^2026-09-05 09:00Z  daily-digest\s+rate-limit\s+run #27$/)
    expect(collapse(log.failures).map((g) => g.count)).toEqual([3, 1])
  })

  it("does not merge across a different cause for the same jig", () => {
    const groups = collapse([entry({ runId: 2, cause: "auth" }), entry({ runId: 1, cause: "composio-spill" })])
    expect(groups.map((g) => g.head.cause)).toEqual(["auth", "composio-spill"])
  })

  it("says so when the window is empty or cut", () => {
    const empty: FailureLog = { generatedAt: "", since: "", failures: [], truncated: false }
    expect(renderFailureLog(empty, target)).toContain("No failed runs in this window.")
    const cut: FailureLog = { generatedAt: "", since: "", failures: [entry()], truncated: true }
    expect(renderFailureLog(cut, target).split("\n")[0]).toContain("(window cut, narrow --since or --jig)")
  })
})

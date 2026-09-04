/**
 * The audit report (GET /api/audit, `jig debug audit`). It is built only from
 * runs, run_steps, schedules, jig_versions and the durable failure-incident and
 * connection-status settings rows, so the tests seed exactly those into an
 * in-memory database and read the report back.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import {
  closeDb,
  completeRun,
  completeStep,
  insertRun,
  insertStep,
  openDb,
  setScheduleEnabled,
  setSetting,
  upsertSchedule,
} from "../src/db.js"
import { buildAuditReport, parseSince } from "../src/services/audit.js"
import { renderAuditReport } from "../src/cli-debug/audit-render.js"
import { matchRoute } from "../src/server/router.js"
import { repairInstructionPrefix } from "../src/services/run-repair.js"
import { writePending } from "../src/services/jig-store.js"
import type { AuditJig, AuditReport, AuditRun } from "../shared/api.js"
import { seedJig } from "./_fixtures.js"

const FAILING = "audit-failing"
const HEALTHY = "audit-healthy"
const HOUR = 60 * 60 * 1000

function source(id: string, connection?: string): string {
  return `
import { jig } from "@jig/sdk"
${connection ? `import { ${connection} } from "@jig/connections/${connection}"` : ""}

export default jig("${id}", { trigger: { type: "cron", cron: "0 9 * * *" } }, async (ctx) => {
  await ctx.step("fetch", [], async () => {})
  await ctx.step("send report", [], async () => { ctx.output("ok") })
})
`
}

/** Insert order is chronological; getJigRuns returns newest first. */
function seedRun(jigId: string, status: "success" | "fail", opts: { error?: string; startedAt?: string } = {}): number {
  const runId = insertRun(jigId)
  completeStep(insertStep(runId, 1, "fetch"), "", "success", 1200, ["composio"])
  const send = insertStep(runId, 2, "send report")
  if (status === "fail") completeStep(send, "", "fail", 300, ["composio"], opts.error ?? "boom")
  else completeStep(send, "ok", "success", 300, ["composio"])
  completeRun(runId, status, 1500, status === "fail" ? opts.error ?? "boom" : undefined)
  if (opts.startedAt) openDb().prepare(`UPDATE runs SET started_at = ? WHERE id = ?`).run(opts.startedAt, runId)
  return runId
}

/** The format datetime('now') writes: UTC, no zone marker. */
function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().slice(0, 19).replace("T", " ")
}

function incident(jigId: string, f: { firstFailedAt: number; lastFailedAt: number; failCount: number; emailsSent: number }): void {
  setSetting(`failure_incident.${jigId}`, { ...f, lastEmailAt: f.lastFailedAt, failCountAtLastEmail: f.failCount })
}

const lastDay = () => buildAuditReport({ since: new Date(Date.now() - 24 * HOUR) })

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

describe("buildAuditReport", () => {
  it("names the failing step and error, counting the streak from runs and the incident", async () => {
    seedJig(FAILING, source(FAILING, "composio"))
    seedRun(FAILING, "success")
    seedRun(FAILING, "fail", { error: "rate limited" })
    seedRun(FAILING, "fail", { error: "token rejected" })
    const firstFailedAt = Date.now() - 5 * HOUR
    incident(FAILING, { firstFailedAt, lastFailedAt: Date.now() - HOUR, failCount: 2, emailsSent: 2 })

    const jig = (await lastDay()).jigs.find((j) => j.id === FAILING)!
    expect(jig.consecutiveFailures).toBe(2)
    // The incident opened before the oldest failed run: the earlier evidence wins.
    expect(jig.failingSince).toBe(new Date(firstFailedAt).toISOString())
    expect(jig.alertsSent).toBe(2)
    expect(jig.lastFailure?.step).toEqual({ seq: 2, label: "send report", error: "token rejected", connections: ["composio"] })
    expect(jig.lastFailure?.error).toBe("token rejected")
    expect(jig.runs).toHaveLength(3)
    expect(jig.runs[0].failingStep?.seq).toBe(2)
    expect(jig.runs[0].steps.map((s) => s.status)).toEqual(["success", "fail"])
    expect(jig.runs[2].status).toBe("success")
    expect(jig.runs[2].failingStep).toBeNull()
  })

  it("trusts the runs table over a stale incident once the latest run succeeded", async () => {
    seedJig(FAILING, source(FAILING))
    seedRun(FAILING, "fail")
    seedRun(FAILING, "success")
    incident(FAILING, { firstFailedAt: Date.now() - HOUR, lastFailedAt: Date.now() - HOUR, failCount: 3, emailsSent: 1 })

    const jig = (await lastDay()).jigs.find((j) => j.id === FAILING)!
    expect(jig.consecutiveFailures).toBe(0)
    expect(jig.lastFailure).toBeNull()
    expect(jig.failingSince).toBeNull()
  })

  it("flags a pending version written by auto-repair, and not one pushed by hand", async () => {
    seedJig(FAILING, source(FAILING))
    seedJig(HEALTHY, source(HEALTHY))
    const repair = writePending({
      jigId: FAILING,
      code: source(FAILING),
      author: "agent",
      message: "retry on 429",
      // The stored prompt is the rendered conversation, so the instruction follows a role prefix.
      prompt: `User: ${repairInstructionPrefix(FAILING)} 2 runs in a row. Latest failure at step "send report":\n\nrate limited`,
    })
    writePending({ jigId: HEALTHY, code: source(HEALTHY), author: "cli", message: "manual edit" })

    const report = await lastDay()
    expect(report.jigs.find((j) => j.id === FAILING)!.pending).toMatchObject({
      versionId: repair.versionId,
      author: "agent",
      message: "retry on 429",
      likelyRepair: true,
    })
    expect(report.jigs.find((j) => j.id === HEALTHY)!.pending?.likelyRepair).toBe(false)
  })

  it("intersects the jig's declared connections with the unhealthy ones", async () => {
    seedJig(FAILING, source(FAILING, "composio"))
    seedJig(HEALTHY, source(HEALTHY, "linear"))
    const at = new Date().toISOString()
    setSetting("connection_status.composio", { state: "auth-required", detail: "401 from provider", at })
    setSetting("connection_status.linear", { state: "ok", detail: null, at })
    setSetting("connection_status.notion", { state: "unreachable", detail: "ECONNREFUSED", at })

    const report = await lastDay()
    expect(report.connections.map((c) => c.name).sort()).toEqual(["composio", "notion"])
    expect(report.connections.find((c) => c.name === "composio")).toEqual({
      name: "composio", state: "auth-required", detail: "401 from provider", at,
    })
    expect(report.jigs.find((j) => j.id === FAILING)!.unhealthyConnections).toEqual(["composio"])
    expect(report.jigs.find((j) => j.id === HEALTHY)!.connections).toEqual(["linear"])
    expect(report.jigs.find((j) => j.id === HEALTHY)!.unhealthyConnections).toEqual([])
  })

  it("reads trigger, overdue, disabled and errored schedules from the schedules table", async () => {
    seedJig(FAILING, source(FAILING))
    seedJig(HEALTHY, source(HEALTHY))
    const nowSec = Math.floor(Date.now() / 1000)
    upsertSchedule(FAILING, "cron", "0 9 * * *", "catch-up", nowSec - 600, null, "UTC")
    upsertSchedule(HEALTHY, "cron", "*/5 * * * *", "skip", nowSec + 600, "bad cron", null)
    setScheduleEnabled(HEALTHY, false)

    const report = await lastDay()
    const failing = report.jigs.find((j) => j.id === FAILING)!
    expect(failing).toMatchObject({ trigger: "cron", cronExpr: "0 9 * * *", timezone: "UTC", enabled: true, scheduleError: null })
    expect(failing.nextRunAt).toBe(new Date((nowSec - 600) * 1000).toISOString())
    expect(report.scheduler.overdue.map((o) => o.jigId)).toEqual([FAILING])
    expect(report.scheduler.disabled).toEqual([HEALTHY])
    expect(report.scheduler.problems).toEqual([{ jigId: HEALTHY, error: "bad cron" }])
    expect(report.jigs.find((j) => j.id === HEALTHY)!.enabled).toBe(false)
  })

  it("leaves a fresh cron that is a few seconds late out of overdue", async () => {
    seedJig(HEALTHY, source(HEALTHY))
    upsertSchedule(HEALTHY, "cron", "* * * * *", "catch-up", Math.floor(Date.now() / 1000) - 30, null, null)
    expect((await lastDay()).scheduler.overdue).toEqual([])
  })

  it("defaults to a manual trigger when there is no schedule row", async () => {
    seedJig(HEALTHY, source(HEALTHY))
    const jig = (await lastDay()).jigs.find((j) => j.id === HEALTHY)!
    expect(jig).toMatchObject({ trigger: "manual", enabled: true, nextRunAt: null, running: false })
  })

  it("limits runs to the window, jigs to the filter, and skips jigs without an active version", async () => {
    seedJig(FAILING, source(FAILING))
    seedJig(HEALTHY, source(HEALTHY))
    writePending({ jigId: "audit-draft", code: source("audit-draft"), author: "cli" })
    seedRun(FAILING, "fail", { startedAt: sqliteTime(Date.now() - 48 * HOUR) })
    seedRun(FAILING, "fail")

    const all = await lastDay()
    expect(all.jigs.map((j) => j.id)).toEqual([FAILING, HEALTHY])
    expect(all.jigs[0].runs).toHaveLength(1)
    // The window trims the listing, not the diagnosis: the older failure still counts.
    expect(all.jigs[0].consecutiveFailures).toBe(2)
    expect(all.truncated.runsPerJig).toBe(10)

    const one = await buildAuditReport({ since: new Date(0), jigId: HEALTHY })
    expect(one.jigs.map((j) => j.id)).toEqual([HEALTHY])
    expect(one.instance.mode).toBe("local")
  })
})

describe("parseSince", () => {
  const now = Date.UTC(2026, 0, 2, 12, 0, 0)

  it("defaults to 24 hours back", () => {
    expect(parseSince(undefined, now).getTime()).toBe(now - 24 * HOUR)
    expect(parseSince("", now).getTime()).toBe(now - 24 * HOUR)
  })

  it("accepts relative windows", () => {
    expect(parseSince("30m", now).getTime()).toBe(now - 30 * 60_000)
    expect(parseSince("6h", now).getTime()).toBe(now - 6 * HOUR)
    expect(parseSince("7d", now).getTime()).toBe(now - 7 * 24 * HOUR)
    expect(parseSince("90s", now).getTime()).toBe(now - 90_000)
  })

  it("accepts an ISO timestamp", () => {
    expect(parseSince("2026-01-01T00:00:00Z", now).toISOString()).toBe("2026-01-01T00:00:00.000Z")
  })

  it("rejects anything else", () => {
    expect(() => parseSince("yesterday", now)).toThrow(/Invalid since/)
    expect(() => parseSince("5w", now)).toThrow(/Invalid since/)
  })
})

describe("router", () => {
  it("routes /api/audit to the audit handler", () => {
    expect(matchRoute("/api/audit")?.handler).toBe("audit")
    expect(matchRoute("/api/audit/extra")).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Text rendering
// ---------------------------------------------------------------------------

function auditJig(overrides: Partial<AuditJig> & { id: string }): AuditJig {
  return {
    name: overrides.id,
    trigger: "cron",
    cronExpr: "0 9 * * *",
    timezone: "UTC",
    enabled: true,
    nextRunAt: null,
    lastRunAt: null,
    scheduleError: null,
    running: false,
    consecutiveFailures: 0,
    failingSince: null,
    lastFailureAt: null,
    alertsSent: 0,
    lastFailure: null,
    runs: [],
    pending: null,
    connections: [],
    unhealthyConnections: [],
    ...overrides,
  }
}

function auditRun(id: number, status: "success" | "fail"): AuditRun {
  return {
    id,
    startedAt: "2026-09-04T09:00:00.000Z",
    finishedAt: "2026-09-04T09:00:02.000Z",
    durationMs: 2000,
    status,
    error: status === "fail" ? "token rejected" : null,
    failingStep: null,
    steps: [],
  }
}

const FIXED_REPORT: AuditReport = {
  generatedAt: "2026-09-04T10:00:30.000Z",
  since: "2026-09-03T10:00:30.000Z",
  instance: { version: "0.1.130", mode: "service", scheduler: { running: true, lastTickAt: "2026-09-04T10:00:00.000Z" } },
  connections: [{ name: "composio", state: "auth-required", detail: "401 from provider", at: "2026-09-03T07:59:00.000Z" }],
  scheduler: {
    problems: [],
    disabled: ["archive-sync"],
    overdue: [{ jigId: "standup-notes", nextRunAt: "2026-09-04T09:00:00.000Z" }],
  },
  jigs: [
    auditJig({
      id: "weekly-update",
      consecutiveFailures: 2,
      failingSince: "2026-09-03T08:00:00.000Z",
      lastFailureAt: "2026-09-04T09:00:02.000Z",
      alertsSent: 2,
      lastFailure: {
        runId: 42,
        at: "2026-09-04T09:00:00.000Z",
        error: "token rejected",
        step: { seq: 2, label: "send report", error: "token rejected", connections: ["composio"] },
      },
      runs: [auditRun(42, "fail"), auditRun(41, "fail"), auditRun(40, "success")],
      connections: ["composio"],
      unhealthyConnections: ["composio"],
    }),
    auditJig({
      id: "daily-digest",
      consecutiveFailures: 3,
      failingSince: "2026-09-02T09:00:00.000Z",
      lastFailure: { runId: 39, at: "2026-09-04T09:00:00.000Z", error: "rate limited", step: null },
      pending: { versionId: 12, author: "agent", message: "retry on 429", createdAt: "2026-09-04T09:05:00.000Z", likelyRepair: true },
    }),
    auditJig({ id: "standup-notes", nextRunAt: "2026-09-04T09:00:00.000Z" }),
    auditJig({ id: "archive-sync", enabled: false }),
    auditJig({ id: "inbox-triage", trigger: "email" }),
  ],
  truncated: { runsPerJig: 10 },
}

describe("renderAuditReport", () => {
  const text = renderAuditReport(FIXED_REPORT, { handle: "prod", url: "https://jig.example.com", since: "24h" })
  const lines = text.split("\n")

  it("leads with the instance and the attention count", () => {
    expect(lines[0]).toBe("prod (https://jig.example.com)  ·  since 24h  ·  4 of 5 jigs need attention")
  })

  it("renders the FAILING block with step, streak, connection hint and the next command", () => {
    const start = lines.indexOf("FAILING")
    expect(start).toBeGreaterThan(0)
    expect(lines[start + 1]).toMatch(/^  weekly-update\s+cron\s+2 consecutive failures since 2026-09-03 08:00Z$/)
    expect(lines[start + 2]).toBe('    step 2 "send report": token rejected')
    expect(lines[start + 3]).toBe("    last 3: fail fail ok")
    expect(lines[start + 4]).toBe("    connection composio is auth-required since 2026-09-03 07:59Z   <- fix the connection, not the code")
    expect(lines[start + 5]).toBe("    -> bun run jig edit weekly-update --out=weekly-update.ts   (fix, then --file=, then run --dry-run)")
  })

  it("points at the pending fix instead of a fresh edit when one is waiting", () => {
    expect(text).toContain('    pending v12 by agent (auto-repair): "retry on 429"')
    expect(text).toContain("    -> bun run jig pending daily-digest")
    expect(text).not.toContain("bun run jig edit daily-digest")
    // No failing step recorded: the run's own error is still shown.
    expect(text).toContain("    error: rate limited")
  })

  it("groups the rest by actionability and closes with scheduler health", () => {
    const section = (name: string) => lines.findIndex((l) => l.startsWith(name))
    expect(section("FAILING")).toBeLessThan(section("DEGRADED"))
    expect(section("DEGRADED")).toBeLessThan(section("PAUSED"))
    expect(section("PAUSED")).toBeLessThan(section("CONNECTIONS"))
    expect(lines[section("DEGRADED") + 1]).toMatch(/^  standup-notes\s+cron\s+due 2026-09-04 09:00Z, has not started$/)
    expect(lines[section("PAUSED") + 1]).toMatch(/^  archive-sync\s+cron\s+disabled/)
    expect(lines[section("CONNECTIONS") + 1]).toMatch(/^  composio\s+auth-required\s+since 2026-09-03 07:59Z: 401 from provider$/)
    expect(text).toContain("HEALTHY (1)   inbox-triage")
    expect(lines[lines.length - 1]).toBe("scheduler: running, last tick 2026-09-04 10:00Z")
  })

  it("does not list a failing jig a second time under DEGRADED or PAUSED", () => {
    const report: AuditReport = {
      ...FIXED_REPORT,
      scheduler: { problems: [], disabled: ["weekly-update"], overdue: [{ jigId: "weekly-update", nextRunAt: "2026-09-04T09:00:00.000Z" }] },
      jigs: [FIXED_REPORT.jigs[0]],
    }
    const out = renderAuditReport(report, { handle: "prod", url: "https://jig.example.com", since: "24h" })
    expect(out).toContain("FAILING")
    expect(out).not.toContain("DEGRADED")
    expect(out).not.toContain("PAUSED")
    expect(out).toContain("1 of 1 jigs need attention")
  })
})

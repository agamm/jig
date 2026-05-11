import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  openDb, closeDb,
  insertRun, completeRun, listRuns, getRun, getJigRuns, getLastRun,
  insertStep, completeStep,
  clearStepCache, deleteJigLocalState, getSchedule, getStepCache, setStepCache, upsertSchedule,
  getSetting, setSetting,
  getToolPermission, listToolPermissions, setToolPermission,
  deleteAgentSession, getAgentSession, listAgentSessions, upsertAgentSession,
} from "../src/db.js"

beforeEach(() => {
  // Use in-memory database for tests
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

describe("runs", () => {
  it("inserts and retrieves a run", () => {
    const runId = insertRun("test-jig", { week: "2026-03-20" })
    expect(runId).toBeGreaterThan(0)

    const run = getRun(runId)
    expect(run).not.toBeNull()
    expect(run!.jig_id).toBe("test-jig")
    expect(run!.status).toBe("running")
    expect(run!.params).toBe('{"week":"2026-03-20"}')
    expect(run!.steps).toEqual([])
  })

  it("completes a run", () => {
    const runId = insertRun("email-triage")
    completeRun(runId, "success", 4200, undefined, "Draft created")

    const run = getRun(runId)
    expect(run!.status).toBe("success")
    expect(run!.duration_ms).toBe(4200)
    expect(run!.finished_at).not.toBeNull()
    expect(run!.output).toBe("Draft created")
  })

  it("completes a failed run with error", () => {
    const runId = insertRun("invoice")
    completeRun(runId, "fail", 1500, "API timeout")

    const run = getRun(runId)
    expect(run!.status).toBe("fail")
    expect(run!.error).toBe("API timeout")
  })

  it("lists runs by jig_id", () => {
    insertRun("test-jig")
    insertRun("test-jig")
    insertRun("invoice")

    const weeklyRuns = listRuns("test-jig")
    expect(weeklyRuns).toHaveLength(2)

    const allRuns = listRuns()
    expect(allRuns).toHaveLength(3)
  })

  it("lists runs with limit", () => {
    for (let i = 0; i < 5; i++) insertRun("test-jig")
    const runs = listRuns("test-jig", 3)
    expect(runs).toHaveLength(3)
  })

  it("gets jig runs", () => {
    insertRun("test-jig")
    insertRun("test-jig")
    insertRun("test-jig")

    const runs = getJigRuns("test-jig")
    expect(runs).toHaveLength(3)
  })

  it("gets last run", () => {
    const r1 = insertRun("test-jig")
    completeRun(r1, "fail", 1000)
    const r2 = insertRun("test-jig")
    completeRun(r2, "success", 2000)

    const last = getLastRun("test-jig")
    expect(last).not.toBeNull()
    expect(last!.id).toBe(r2)
    expect(last!.status).toBe("success")
  })

  it("returns null for nonexistent run", () => {
    expect(getRun(999)).toBeNull()
    expect(getLastRun("nonexistent")).toBeNull()
  })
})

describe("steps", () => {
  it("inserts and retrieves steps with a run", () => {
    const runId = insertRun("test-jig")
    const s1 = insertStep(runId, 1, "Search emails")
    const s2 = insertStep(runId, 2, "Draft update")

    completeStep(s1, "Found 5 emails", "success", 800, ["workspace"])
    completeStep(s2, "Draft created", "success", 2100, [])

    const run = getRun(runId)
    expect(run!.steps).toHaveLength(2)
    expect(run!.steps[0].label).toBe("Search emails")
    expect(run!.steps[0].output).toBe("Found 5 emails")
    expect(run!.steps[0].status).toBe("success")
    expect(run!.steps[0].duration_ms).toBe(800)
    expect(run!.steps[1].seq).toBe(2)
  })

  it("records healed steps", () => {
    const runId = insertRun("invoice")
    const stepId = insertStep(runId, 1, "Parse timesheet")
    completeStep(stepId, "Recovered from format change", "healed", 3500, [])

    const run = getRun(runId)
    expect(run!.steps[0].status).toBe("healed")
  })

  it("records failed steps with error", () => {
    const runId = insertRun("invoice")
    const stepId = insertStep(runId, 1, "Call Mercury API")
    completeStep(stepId, "", "fail", 500, [], "401 Unauthorized")

    const run = getRun(runId)
    expect(run!.steps[0].status).toBe("fail")
    expect(run!.steps[0].error).toBe("401 Unauthorized")
  })
})

describe("getJigRuns includes steps", () => {
  it("returns runs with their steps", () => {
    const runId = insertRun("test-jig")
    insertStep(runId, 1, "Gather data")
    insertStep(runId, 2, "Write email")

    const runs = getJigRuns("test-jig")
    expect(runs).toHaveLength(1)
    expect(runs[0].steps).toHaveLength(2)
  })
})

describe("deleteJigLocalState", () => {
  it("removes runs, steps, cache, and schedules for a deleted jig id", () => {
    const runId = insertRun("test-jig")
    insertStep(runId, 1, "Gather data")
    setStepCache("test-jig", "abc123", [{ num: 1, name: "Gather data", connections: [] }])
    upsertSchedule("test-jig", "cron", "0 8 * * 1", "catch-up", 1234567890, null)
    insertRun("other-jig")

    deleteJigLocalState("test-jig")

    expect(getJigRuns("test-jig")).toEqual([])
    expect(getLastRun("test-jig")).toBeNull()
    expect(getSchedule("test-jig")).toBeNull()
    expect(getStepCache("test-jig", "abc123")).toBeNull()
    expect(listRuns("other-jig")).toHaveLength(1)
  })
})

describe("settings", () => {
  it("returns null for missing key", () => {
    expect(getSetting("nonexistent")).toBeNull()
  })

  it("round-trips a JSON value", () => {
    setSetting("notifications", { channels: [{ connection: "composio", tool: "telegram_send_message", recipient: "42" }], triggerOn: { fail: true } })
    const got = getSetting<{ channels: unknown[]; triggerOn: { fail: boolean } }>("notifications")
    expect(got).not.toBeNull()
    expect(got!.triggerOn.fail).toBe(true)
    expect(got!.channels).toHaveLength(1)
  })

  it("overwrites on re-set", () => {
    setSetting("k", { a: 1 })
    setSetting("k", { a: 2 })
    expect(getSetting<{ a: number }>("k")!.a).toBe(2)
  })
})

describe("agent sessions", () => {
  it("round-trips persisted authoring sessions", () => {
    upsertAgentSession({
      session_id: "session-1",
      jig_id: "draft-jig",
      creation_mode: 1,
      authoring_intent: "User: build a draft",
      conversation_history: JSON.stringify([{ role: "user", content: "build a draft" }]),
      authoring_policy: JSON.stringify({ requiresIntegration: false, buildResolutions: [] }),
      messages: JSON.stringify([{ role: "user", content: "build a draft" }]),
      events: JSON.stringify([{ type: "text", content: "Draft ready" }]),
      status: "waiting",
      metrics: JSON.stringify({ round: 2 }),
      created_at: 123,
      updated_at: 456,
      pending_ask_tool_call_id: null,
      pending_ask_question: null,
      draft_file_path: "/tmp/draft-jig.ts",
      draft_approval: null,
      last_event_seq: 0,
    })

    const row = getAgentSession("session-1")
    expect(row?.jig_id).toBe("draft-jig")
    expect(row?.status).toBe("waiting")
    expect(listAgentSessions()).toHaveLength(1)

    deleteAgentSession("session-1")
    expect(getAgentSession("session-1")).toBeNull()
  })
})

describe("db recovery", () => {
  it("re-runs migrations after recreating a broken on-disk database", () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-db-recovery-"))
    const dbPath = join(dir, "broken.db")
    writeFileSync(dbPath, "not a sqlite database")

    closeDb()
    const db = openDb(dbPath)
    const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{ name: string }>
    const tableNames = tables.map((row) => row.name)

    expect(tableNames).toContain("settings")
    expect(tableNames).toContain("tool_permissions")

    closeDb()
    rmSync(dir, { recursive: true, force: true })
  })
})

describe("tool permissions", () => {
  it("defaults to null when no policy exists", () => {
    expect(getToolPermission("workspace", "gmail_send")).toBeNull()
  })

  it("round-trips and updates a policy", () => {
    setToolPermission("workspace", "gmail_send", "ask")
    expect(getToolPermission("workspace", "gmail_send")).toBe("ask")

    setToolPermission("workspace", "gmail_send", "always")
    expect(getToolPermission("workspace", "gmail_send")).toBe("always")
    expect(listToolPermissions()).toHaveLength(1)
  })
})

describe("step connections", () => {
  it("persists connections on steps", () => {
    const runId = insertRun("test-jig")
    const stepId = insertStep(runId, 1, "Gather data")
    completeStep(stepId, "Done", "success", 1000, ["granola", "workspace", "github"])

    const run = getRun(runId)
    expect(run!.steps[0].connections).toBe('["granola","workspace","github"]')
  })
})

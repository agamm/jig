import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { Database } from "bun:sqlite"
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import {
  openDb, closeDb, runMigrations,
  insertRun, completeRun, listRuns, getRun, getJigRuns, getLastRun,
  insertStep, completeStep,
  deleteJigLocalState, getSchedule, getStepCache, setStepCache, upsertSchedule,
  getSetting, setSetting,
  getToolPermission, listToolPermissions, setToolPermission,
  deleteAgentSession, getAgentSession, jigHasActiveSession, listAgentSessions, upsertAgentSession,
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

describe("jigHasActiveSession", () => {
  const row = (overrides: Partial<Parameters<typeof upsertAgentSession>[0]>): Parameters<typeof upsertAgentSession>[0] => ({
    session_id: "s",
    jig_id: "foo",
    creation_mode: 0,
    authoring_intent: "",
    conversation_history: "[]",
    authoring_policy: '{"requiresIntegration":false,"buildResolutions":[]}',
    messages: "[]",
    events: "[]",
    status: "waiting",
    metrics: "{}",
    created_at: 1,
    updated_at: 1,
    pending_ask_tool_call_id: null,
    pending_ask_question: null,
    draft_approval: null,
    last_event_seq: 0,
    ...overrides,
  })

  it("returns false when no session claims the jig", () => {
    expect(jigHasActiveSession("foo")).toBe(false)
  })

  it("returns true for thinking/tool-calling/waiting", () => {
    for (const status of ["thinking", "tool-calling", "waiting"] as const) {
      upsertAgentSession(row({ session_id: `s-${status}`, jig_id: "foo", status }))
      expect(jigHasActiveSession("foo")).toBe(true)
      deleteAgentSession(`s-${status}`)
    }
  })

  it("ignores terminal sessions", () => {
    upsertAgentSession(row({ session_id: "s-done", jig_id: "foo", status: "done" }))
    upsertAgentSession(row({ session_id: "s-err", jig_id: "foo", status: "error" }))
    expect(jigHasActiveSession("foo")).toBe(false)
  })

  it("respects the excludeSessionId filter", () => {
    upsertAgentSession(row({ session_id: "s-active", jig_id: "foo", status: "thinking" }))
    expect(jigHasActiveSession("foo")).toBe(true)
    expect(jigHasActiveSession("foo", "s-active")).toBe(false)
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

describe("schema/migration convergence", () => {
  /**
   * The schema as of BASELINE_VERSION (v20) — i.e. SCHEMA plus whatever later
   * migrations have since removed. Only the delta needs to be expressed here:
   * the test applies MIGRATIONS to a v20 database and checks it lands on the
   * same shape a brand-new database gets from SCHEMA.
   *
   * When you add a migration, add its inverse here.
   */
  const BASELINE_DELTA = `
    ALTER TABLE agent_sessions ADD COLUMN draft_file_path TEXT;
  `
  const BASELINE_VERSION = 20

  /** table -> sorted column names, plus the set of index names. Ignores column
   *  ORDER and DDL text, which legitimately differ between the two paths. */
  function logicalSchema(db: Database): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    const objects = db.prepare(
      `SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name`,
    ).all() as { type: string; name: string }[]
    const indexes: string[] = []
    for (const obj of objects) {
      if (obj.type === "index") { indexes.push(obj.name); continue }
      if (obj.type !== "table") continue
      const cols = db.prepare(`PRAGMA table_info("${obj.name}")`).all() as { name: string }[]
      out[obj.name] = cols.map((c) => c.name).sort()
    }
    out["<indexes>"] = indexes.sort()
    return out
  }

  it("fresh and migrated databases converge on the same schema", () => {
    // "Fresh" goes through the real bootstrap path.
    closeDb()
    const fresh = openDb(":memory:")
    const freshSchema = logicalSchema(fresh)
    const freshVersion = (fresh.prepare("PRAGMA user_version").get() as any).user_version
    closeDb()

    // "Upgraded" starts at the baseline generation and replays the migrations.
    closeDb()
    const upgraded = openDb(":memory:")
    upgraded.exec(BASELINE_DELTA)
    upgraded.exec(`PRAGMA user_version = ${BASELINE_VERSION}`)
    runMigrations(upgraded)

    expect(logicalSchema(upgraded)).toEqual(freshSchema)
    expect((upgraded.prepare("PRAGMA user_version").get() as any).user_version).toBe(freshVersion)
    closeDb()
  })

  it("refuses a database older than the squashed baseline", () => {
    closeDb()
    const ancient = openDb(":memory:")
    ancient.exec(`PRAGMA user_version = 7`)
    expect(() => runMigrations(ancient)).toThrow(/predates the v20 baseline/)
    closeDb()
  })
})

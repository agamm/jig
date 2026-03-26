import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  openDb, closeDb,
  insertRun, completeRun, listRuns, getRun, getJigRuns, getLastRun,
  insertStep, completeStep,
  upsertJigSteps, getJigSteps, upsertJigMeta, getJigMeta, cleanupOrphanedMeta,
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
    const runId = insertRun("weekly-update", "acme", { week: "2026-03-20" })
    expect(runId).toBeGreaterThan(0)

    const run = getRun(runId)
    expect(run).not.toBeNull()
    expect(run!.jig_id).toBe("weekly-update")
    expect(run!.entity).toBe("acme")
    expect(run!.status).toBe("running")
    expect(run!.params).toBe('{"week":"2026-03-20"}')
    expect(run!.steps).toEqual([])
  })

  it("completes a run", () => {
    const runId = insertRun("email-triage")
    completeRun(runId, "success", 4200)

    const run = getRun(runId)
    expect(run!.status).toBe("success")
    expect(run!.duration_ms).toBe(4200)
    expect(run!.finished_at).not.toBeNull()
  })

  it("completes a failed run with error", () => {
    const runId = insertRun("invoice")
    completeRun(runId, "fail", 1500, "API timeout")

    const run = getRun(runId)
    expect(run!.status).toBe("fail")
    expect(run!.error).toBe("API timeout")
  })

  it("lists runs by jig_id", () => {
    insertRun("weekly-update")
    insertRun("weekly-update")
    insertRun("invoice")

    const weeklyRuns = listRuns("weekly-update")
    expect(weeklyRuns).toHaveLength(2)

    const allRuns = listRuns()
    expect(allRuns).toHaveLength(3)
  })

  it("lists runs with limit", () => {
    for (let i = 0; i < 5; i++) insertRun("weekly-update")
    const runs = listRuns("weekly-update", 3)
    expect(runs).toHaveLength(3)
  })

  it("gets jig runs with entity filter", () => {
    insertRun("weekly-update", "acme")
    insertRun("weekly-update", "globex")
    insertRun("weekly-update", "acme")

    const acmeRuns = getJigRuns("weekly-update", "acme")
    expect(acmeRuns).toHaveLength(2)
    expect(acmeRuns[0].entity).toBe("acme")
  })

  it("gets last run", () => {
    const r1 = insertRun("weekly-update")
    completeRun(r1, "fail", 1000)
    const r2 = insertRun("weekly-update")
    completeRun(r2, "success", 2000)

    const last = getLastRun("weekly-update")
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
    const runId = insertRun("weekly-update")
    const s1 = insertStep(runId, 1, "Search emails")
    const s2 = insertStep(runId, 2, "Draft update")

    completeStep(s1, "Found 5 emails", "success", 800)
    completeStep(s2, "Draft created", "success", 2100)

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
    completeStep(stepId, "Recovered from format change", "healed", 3500)

    const run = getRun(runId)
    expect(run!.steps[0].status).toBe("healed")
  })

  it("records failed steps with error", () => {
    const runId = insertRun("invoice")
    const stepId = insertStep(runId, 1, "Call Mercury API")
    completeStep(stepId, "", "fail", 500, "401 Unauthorized")

    const run = getRun(runId)
    expect(run!.steps[0].status).toBe("fail")
    expect(run!.steps[0].error).toBe("401 Unauthorized")
  })
})

describe("getJigRuns includes steps", () => {
  it("returns runs with their steps", () => {
    const runId = insertRun("weekly-update")
    insertStep(runId, 1, "Gather data")
    insertStep(runId, 2, "Write email")

    const runs = getJigRuns("weekly-update")
    expect(runs).toHaveLength(1)
    expect(runs[0].steps).toHaveLength(2)
  })
})

describe("jig_steps", () => {
  it("upserts and retrieves steps for a jig", () => {
    const steps = [
      { name: "Search emails", description: "gmail.search(query)", costHint: null },
      { name: "Generate draft", description: "llm('Write email')", costHint: "$0.003" },
    ]
    upsertJigSteps("weekly-update", null, steps)
    const result = getJigSteps("weekly-update", null)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe("Search emails")
    expect(result[1].cost_hint).toBe("$0.003")
  })

  it("replaces steps on re-upsert", () => {
    upsertJigSteps("test", null, [{ name: "A", description: "a", costHint: null }])
    upsertJigSteps("test", null, [{ name: "B", description: "b", costHint: null }])
    const result = getJigSteps("test", null)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("B")
  })

  it("handles entity-scoped steps", () => {
    upsertJigSteps("invoice", "acme", [{ name: "Read timesheet", description: "drive.read()", costHint: null }])
    upsertJigSteps("invoice", "globex", [{ name: "Read timesheet", description: "drive.read()", costHint: null }])
    expect(getJigSteps("invoice", "acme")).toHaveLength(1)
    expect(getJigSteps("invoice", "globex")).toHaveLength(1)
    expect(getJigSteps("invoice", null)).toHaveLength(0)
  })
})

describe("jig_meta", () => {
  it("upserts and retrieves meta", () => {
    upsertJigMeta("weekly-update", null, "abc123")
    const meta = getJigMeta("weekly-update", null)
    expect(meta).not.toBeNull()
    expect(meta!.code_hash).toBe("abc123")
  })

  it("cleans up orphaned meta", () => {
    upsertJigMeta("exists", null, "hash1")
    upsertJigMeta("deleted", null, "hash2")
    upsertJigSteps("deleted", null, [{ name: "X", description: "x", costHint: null }])
    cleanupOrphanedMeta(new Set(["exists"]))
    expect(getJigMeta("exists", null)).not.toBeNull()
    expect(getJigMeta("deleted", null)).toBeNull()
    expect(getJigSteps("deleted", null)).toHaveLength(0)
  })
})

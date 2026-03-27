/**
 * SQLite database module — run history and step results.
 *
 * Uses bun:sqlite. Opens/creates jig.db at project root.
 * Discovery (discoverJigs) is the source of truth for jig metadata.
 * This module only stores execution history.
 */
import { Database } from "bun:sqlite"
import { join } from "path"

const PROJECT_ROOT = join(import.meta.dir, "..")

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunRow {
  id: number
  jig_id: string
  entity: string | null
  started_at: string
  finished_at: string | null
  status: "running" | "success" | "fail"
  duration_ms: number | null
  error: string | null
  params: string | null // JSON
}

export interface StepRow {
  id: number
  run_id: number
  seq: number
  label: string
  started_at: string | null
  finished_at: string | null
  duration_ms: number | null
  output: string | null
  status: "running" | "success" | "fail" | "healed"
  error: string | null
}

export interface JigStepRow {
  jig_id: string
  entity: string | null
  seq: number
  name: string
  description: string
  cost_hint: string | null
  connections: string | null // JSON array of connection names
  tools: string | null       // JSON array of exact MCP tool names
  agent_group: string | null
}

export interface JigMetaRow {
  jig_id: string
  entity: string | null
  code_hash: string
  steps_derived_at: string
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jig_id TEXT NOT NULL,
  entity TEXT,
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  duration_ms INTEGER,
  error TEXT,
  params TEXT
);

CREATE TABLE IF NOT EXISTS run_steps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id INTEGER NOT NULL REFERENCES runs(id),
  seq INTEGER NOT NULL,
  label TEXT NOT NULL,
  started_at TEXT DEFAULT (datetime('now')),
  finished_at TEXT,
  duration_ms INTEGER,
  output TEXT,
  status TEXT DEFAULT 'running',
  error TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_jig_id ON runs(jig_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id);

CREATE TABLE IF NOT EXISTS jig_steps (
  jig_id TEXT NOT NULL,
  entity TEXT,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  cost_hint TEXT,
  connections TEXT,
  tools TEXT,
  agent_group TEXT
);
CREATE INDEX IF NOT EXISTS idx_jig_steps_jig ON jig_steps(jig_id, entity);

CREATE TABLE IF NOT EXISTS jig_meta (
  jig_id TEXT NOT NULL,
  entity TEXT,
  code_hash TEXT NOT NULL,
  steps_derived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jig_meta_jig ON jig_meta(jig_id, COALESCE(entity, ''));
`

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

let _db: Database | null = null

export function openDb(path?: string): Database {
  if (_db) return _db
  const dbPath = path ?? join(PROJECT_ROOT, "jig.db")
  try {
    _db = new Database(dbPath)
    _db.exec("PRAGMA journal_mode = WAL")
    _db.exec("PRAGMA foreign_keys = ON")
    _db.exec(SCHEMA)
  } catch (e) {
    // If DB is corrupted, delete and retry once
    if (dbPath !== ":memory:") {
      console.warn("DB error, recreating:", (e as Error)?.message)
      try { require("fs").unlinkSync(dbPath) } catch {}
      try { require("fs").unlinkSync(dbPath + "-shm") } catch {}
      try { require("fs").unlinkSync(dbPath + "-wal") } catch {}
      _db = new Database(dbPath)
      _db.exec("PRAGMA journal_mode = WAL")
      _db.exec("PRAGMA foreign_keys = ON")
      _db.exec(SCHEMA)
    } else {
      throw e
    }
  }
  return _db
}

/** For testing — close and reset the singleton */
export function closeDb(): void {
  if (_db) {
    _db.close()
    _db = null
  }
}

// ---------------------------------------------------------------------------
// Runs
// ---------------------------------------------------------------------------

export function insertRun(
  jigId: string,
  entity?: string,
  params?: Record<string, string>
): number {
  const db = openDb()
  const stmt = db.prepare(
    `INSERT INTO runs (jig_id, entity, params) VALUES (?, ?, ?)`
  )
  const result = stmt.run(jigId, entity ?? null, params ? JSON.stringify(params) : null)
  return Number(result.lastInsertRowid)
}

export function completeRun(
  runId: number,
  status: "success" | "fail",
  durationMs: number,
  error?: string
): void {
  const db = openDb()
  db.prepare(
    `UPDATE runs SET status = ?, duration_ms = ?, finished_at = datetime('now'), error = ? WHERE id = ?`
  ).run(status, durationMs, error ?? null, runId)
}

export function listRuns(jigId?: string, limit = 20): RunRow[] {
  const db = openDb()
  if (jigId) {
    return db
      .prepare(`SELECT * FROM runs WHERE jig_id = ? ORDER BY id DESC LIMIT ?`)
      .all(jigId, limit) as RunRow[]
  }
  return db
    .prepare(`SELECT * FROM runs ORDER BY id DESC LIMIT ?`)
    .all(limit) as RunRow[]
}

export function getRun(runId: number): (RunRow & { steps: StepRow[] }) | null {
  const db = openDb()
  const run = db.prepare(`SELECT * FROM runs WHERE id = ?`).get(runId) as RunRow | null
  if (!run) return null
  const steps = db
    .prepare(`SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq`)
    .all(runId) as StepRow[]
  return { ...run, steps }
}

export function getJigRuns(
  jigId: string,
  entity?: string,
  limit = 10
): (RunRow & { steps: StepRow[] })[] {
  const db = openDb()
  let runs: RunRow[]
  if (entity) {
    runs = db
      .prepare(`SELECT * FROM runs WHERE jig_id = ? AND entity = ? ORDER BY id DESC LIMIT ?`)
      .all(jigId, entity, limit) as RunRow[]
  } else {
    runs = db
      .prepare(`SELECT * FROM runs WHERE jig_id = ? ORDER BY id DESC LIMIT ?`)
      .all(jigId, limit) as RunRow[]
  }
  return runs.map((run) => {
    const steps = db
      .prepare(`SELECT * FROM run_steps WHERE run_id = ? ORDER BY seq`)
      .all(run.id) as StepRow[]
    return { ...run, steps }
  })
}

/** Get the most recent run for a jig (optionally per entity) */
export function getLastRun(jigId: string, entity?: string): RunRow | null {
  const db = openDb()
  if (entity) {
    return db
      .prepare(`SELECT * FROM runs WHERE jig_id = ? AND entity = ? ORDER BY id DESC LIMIT 1`)
      .get(jigId, entity) as RunRow | null
  }
  return db
    .prepare(`SELECT * FROM runs WHERE jig_id = ? ORDER BY id DESC LIMIT 1`)
    .get(jigId) as RunRow | null
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

export function insertStep(runId: number, seq: number, label: string): number {
  const db = openDb()
  const result = db
    .prepare(`INSERT INTO run_steps (run_id, seq, label) VALUES (?, ?, ?)`)
    .run(runId, seq, label)
  return Number(result.lastInsertRowid)
}

export function completeStep(
  stepId: number,
  output: string,
  status: "success" | "fail" | "healed",
  durationMs: number,
  error?: string
): void {
  const db = openDb()
  db.prepare(
    `UPDATE run_steps SET output = ?, status = ?, duration_ms = ?, finished_at = datetime('now'), error = ? WHERE id = ?`
  ).run(output, status, durationMs, error ?? null, stepId)
}

// ---------------------------------------------------------------------------
// Jig Steps (LLM-derived step descriptions)
// ---------------------------------------------------------------------------

export function upsertJigSteps(
  jigId: string,
  entity: string | null,
  steps: { name: string; description: string; costHint: string | null; connections?: string[]; tools?: string[]; agentGroup?: string }[]
): void {
  const db = openDb()
  db.prepare(`DELETE FROM jig_steps WHERE jig_id = ? AND entity IS ?`).run(jigId, entity)
  const stmt = db.prepare(`INSERT INTO jig_steps (jig_id, entity, seq, name, description, cost_hint, connections, tools, agent_group) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
  for (let i = 0; i < steps.length; i++) {
    const conns = steps[i].connections?.length ? JSON.stringify(steps[i].connections) : null
    const tools = steps[i].tools?.length ? JSON.stringify(steps[i].tools) : null
    const group = steps[i].agentGroup?.trim() || null
    stmt.run(jigId, entity, i + 1, steps[i].name, steps[i].description, steps[i].costHint, conns, tools, group)
  }
}

export function getJigSteps(jigId: string, entity: string | null): JigStepRow[] {
  const db = openDb()
  return db.prepare(`SELECT * FROM jig_steps WHERE jig_id = ? AND entity IS ? ORDER BY seq`).all(jigId, entity) as JigStepRow[]
}

export function upsertJigMeta(jigId: string, entity: string | null, codeHash: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM jig_meta WHERE jig_id = ? AND entity IS ?`).run(jigId, entity)
  db.prepare(`INSERT INTO jig_meta (jig_id, entity, code_hash) VALUES (?, ?, ?)`).run(jigId, entity, codeHash)
}

export function getJigMeta(jigId: string, entity: string | null): JigMetaRow | null {
  const db = openDb()
  return db.prepare(`SELECT * FROM jig_meta WHERE jig_id = ? AND entity IS ?`).get(jigId, entity) as JigMetaRow | null
}

export function cleanupOrphanedMeta(activeJigIds: Set<string>): void {
  const db = openDb()
  const allMeta = db.prepare(`SELECT DISTINCT jig_id FROM jig_meta`).all() as { jig_id: string }[]
  for (const { jig_id } of allMeta) {
    if (!activeJigIds.has(jig_id)) {
      db.prepare(`DELETE FROM jig_meta WHERE jig_id = ?`).run(jig_id)
      db.prepare(`DELETE FROM jig_steps WHERE jig_id = ?`).run(jig_id)
    }
  }
}

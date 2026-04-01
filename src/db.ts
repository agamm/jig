/**
 * SQLite database module — run history and step results.
 *
 * Uses bun:sqlite. Opens/creates jig.db at project root.
 * Discovery (discoverJigs) is the source of truth for jig metadata.
 * This module only stores execution history.
 */
import { Database } from "bun:sqlite"
import { PROJECT_ROOT } from "./config/paths.js"

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
  connections: string | null // JSON array of connection names
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
  error TEXT,
  connections TEXT
);

CREATE INDEX IF NOT EXISTS idx_runs_jig_id ON runs(jig_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);
CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id);

CREATE TABLE IF NOT EXISTS step_cache (
  jig_id TEXT NOT NULL,
  entity TEXT,
  code_hash TEXT NOT NULL,
  steps TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_step_cache_jig ON step_cache(jig_id, COALESCE(entity, ''));
`

// Versioned migrations — each runs once, tracked by PRAGMA user_version.
const MIGRATIONS: string[] = [
  // v1: drop old LLM-derived step tables, add connections column
  `DROP TABLE IF EXISTS jig_steps;
   DROP TABLE IF EXISTS jig_meta;
   ALTER TABLE run_steps ADD COLUMN connections TEXT;`,
]

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

function runMigrations(db: Database) {
  const current = (db.prepare("PRAGMA user_version").get() as any)?.user_version ?? 0
  for (let i = current; i < MIGRATIONS.length; i++) {
    try {
      db.exec(MIGRATIONS[i])
    } catch (e: any) {
      // Expected: column/table already exists from a partial prior run
      const msg = e?.message ?? ""
      if (!msg.includes("duplicate column") && !msg.includes("already exists")) {
        throw e
      }
    }
  }
  if (MIGRATIONS.length > current) {
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`)
  }
}

let _db: Database | null = null

export function openDb(path?: string): Database {
  if (_db) return _db
  const dbPath = path ?? `${PROJECT_ROOT}/jig.db`
  try {
    _db = new Database(dbPath)
    _db.exec("PRAGMA journal_mode = WAL")
    _db.exec("PRAGMA foreign_keys = ON")
    _db.exec(SCHEMA)
    runMigrations(_db)
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
  params?: Record<string, string>
): number {
  const db = openDb()
  const stmt = db.prepare(
    `INSERT INTO runs (jig_id, entity, params) VALUES (?, ?, ?)`
  )
  const result = stmt.run(jigId, null, params ? JSON.stringify(params) : null)
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
  limit = 10
): (RunRow & { steps: StepRow[] })[] {
  const db = openDb()
  const runs = db
    .prepare(`SELECT * FROM runs WHERE jig_id = ? ORDER BY id DESC LIMIT ?`)
    .all(jigId, limit) as RunRow[]
  if (runs.length === 0) return []
  const ids = runs.map((r) => r.id)
  const placeholders = ids.map(() => "?").join(",")
  const allSteps = db
    .prepare(`SELECT * FROM run_steps WHERE run_id IN (${placeholders}) ORDER BY run_id, seq`)
    .all(...ids) as StepRow[]
  const stepsByRun = new Map<number, StepRow[]>()
  for (const step of allSteps) {
    const arr = stepsByRun.get(step.run_id)
    if (arr) arr.push(step)
    else stepsByRun.set(step.run_id, [step])
  }
  return runs.map((run) => ({ ...run, steps: stepsByRun.get(run.id) ?? [] }))
}

/** Get the most recent run for a jig */
export function getLastRun(jigId: string): RunRow | null {
  const db = openDb()
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
  connections: string[],
  error?: string
): void {
  const db = openDb()
  db.prepare(
    `UPDATE run_steps SET output = ?, status = ?, duration_ms = ?, finished_at = datetime('now'), error = ?, connections = ? WHERE id = ?`
  ).run(output, status, durationMs, error ?? null, connections.length ? JSON.stringify(connections) : null, stepId)
}

// ---------------------------------------------------------------------------
// Step cache (scan + LLM humanized labels, keyed by code hash)
// ---------------------------------------------------------------------------

export interface CachedStepTool { connection: string; name: string; readOnly: boolean }
export interface CachedStep { num: number; name: string; connections: string[]; tools?: CachedStepTool[] }

export function getStepCache(jigId: string, codeHash: string): CachedStep[] | null {
  const db = openDb()
  const row = db.prepare(
    `SELECT steps FROM step_cache WHERE jig_id = ? AND code_hash = ?`
  ).get(jigId, codeHash) as { steps: string } | null
  return row ? JSON.parse(row.steps) : null
}

export function setStepCache(jigId: string, codeHash: string, steps: CachedStep[]): void {
  const db = openDb()
  db.prepare(
    `INSERT OR REPLACE INTO step_cache (jig_id, entity, code_hash, steps) VALUES (?, ?, ?, ?)`
  ).run(jigId, null, codeHash, JSON.stringify(steps))
}

export function clearStepCache(jigId: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM step_cache WHERE jig_id = ?`).run(jigId)
}

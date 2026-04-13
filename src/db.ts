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
  started_at: string
  finished_at: string | null
  status: "running" | "success" | "fail"
  duration_ms: number | null
  error: string | null
  output: string | null
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
  started_at TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  duration_ms INTEGER,
  error TEXT,
  output TEXT,
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
  code_hash TEXT NOT NULL,
  steps TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_step_cache_jig ON step_cache(jig_id);

CREATE TABLE IF NOT EXISTS tool_permissions (
  connection TEXT NOT NULL,
  tool TEXT NOT NULL,
  policy TEXT NOT NULL CHECK(policy IN ('always', 'ask', 'never')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection, tool)
);
`

// Versioned migrations — each runs once, tracked by PRAGMA user_version.
const MIGRATIONS: string[] = [
  // v1: drop old LLM-derived step tables, add connections column
  `DROP TABLE IF EXISTS jig_steps;
   DROP TABLE IF EXISTS jig_meta;
   ALTER TABLE run_steps ADD COLUMN connections TEXT;`,
  // v2: durable scheduler — schedules table (error column included)
  `CREATE TABLE IF NOT EXISTS schedules (
     jig_id TEXT PRIMARY KEY,
     trigger_type TEXT NOT NULL,
     cron_expr TEXT,
     missed_strategy TEXT NOT NULL DEFAULT 'catch-up',
     next_run_at INTEGER,
     last_run_at INTEGER,
     enabled INTEGER NOT NULL DEFAULT 1,
     error TEXT
   );`,
  // v3: authorized senders for channel triggers (Telegram chat IDs, phone numbers, emails)
  // + credentials for MCP server connections (API keys, server IDs, etc.)
  `CREATE TABLE IF NOT EXISTS authorized_senders (
     channel TEXT NOT NULL,
     sender_id TEXT NOT NULL,
     authorized_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (channel, sender_id)
   );
   CREATE TABLE IF NOT EXISTS credentials (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     server TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
  // v4: ensure credentials table exists (fixes DBs that migrated before credentials was added)
  `CREATE TABLE IF NOT EXISTS credentials (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     server TEXT NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
  // v5: generic settings table (key/value JSON) — used by notifications settings
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
  // v6: remove abandoned entity support, add backend-owned tool permissions
  `CREATE TABLE IF NOT EXISTS tool_permissions (
     connection TEXT NOT NULL,
     tool TEXT NOT NULL,
     policy TEXT NOT NULL CHECK(policy IN ('always', 'ask', 'never')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now')),
     PRIMARY KEY (connection, tool)
   );
   DROP INDEX IF EXISTS idx_step_cache_jig;
   ALTER TABLE runs DROP COLUMN entity;
   ALTER TABLE step_cache DROP COLUMN entity;
   CREATE UNIQUE INDEX IF NOT EXISTS idx_step_cache_jig ON step_cache(jig_id);`,
  // v7: persist run-level output for historical run previews/fallbacks
  `ALTER TABLE runs ADD COLUMN output TEXT;`,
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
      if (
        !msg.includes("duplicate column") &&
        !msg.includes("already exists") &&
        !msg.includes("no such column")
      ) {
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
      runMigrations(_db)
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
  params?: Record<string, unknown>
): number {
  const db = openDb()
  const stmt = db.prepare(
    `INSERT INTO runs (jig_id, params) VALUES (?, ?)`
  )
  const result = stmt.run(jigId, params ? JSON.stringify(params) : null)
  return Number(result.lastInsertRowid)
}

export function completeRun(
  runId: number,
  status: "success" | "fail",
  durationMs: number,
  error?: string,
  output?: string
): void {
  const db = openDb()
  db.prepare(
    `UPDATE runs SET status = ?, duration_ms = ?, finished_at = datetime('now'), error = ?, output = ? WHERE id = ?`
  ).run(status, durationMs, error ?? null, output ?? null, runId)
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
  db.prepare(`DELETE FROM step_cache WHERE jig_id = ?`).run(jigId)
  db.prepare(
    `INSERT INTO step_cache (jig_id, code_hash, steps) VALUES (?, ?, ?)`
  ).run(jigId, codeHash, JSON.stringify(steps))
}

export function clearAllStepCache(): void {
  const db = openDb()
  db.prepare(`DELETE FROM step_cache`).run()
}

export function clearStepCache(jigId: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM step_cache WHERE jig_id = ?`).run(jigId)
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export interface ScheduleRow {
  jig_id: string
  trigger_type: "cron" | "webhook"
  cron_expr: string | null
  missed_strategy: "catch-up" | "skip"
  next_run_at: number | null
  last_run_at: number | null
  enabled: number // 1 or 0
  error: string | null
}

export function getSchedule(jigId: string): ScheduleRow | null {
  const db = openDb()
  return db.prepare(`SELECT * FROM schedules WHERE jig_id = ?`).get(jigId) as ScheduleRow | null
}

export function upsertSchedule(
  jigId: string,
  triggerType: "cron" | "webhook",
  cronExpr: string | null,
  missedStrategy: "catch-up" | "skip",
  nextRunAt: number | null,
  error: string | null,
): void {
  const db = openDb()
  db.prepare(
    `INSERT INTO schedules (jig_id, trigger_type, cron_expr, missed_strategy, next_run_at, error)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(jig_id) DO UPDATE SET
       trigger_type = excluded.trigger_type,
       cron_expr = excluded.cron_expr,
       missed_strategy = excluded.missed_strategy,
       next_run_at = excluded.next_run_at,
       error = excluded.error`
  ).run(jigId, triggerType, cronExpr, missedStrategy, nextRunAt, error)
}

export function deleteSchedule(jigId: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM schedules WHERE jig_id = ?`).run(jigId)
}

export function listDueSchedules(nowUnix: number): ScheduleRow[] {
  const db = openDb()
  return db.prepare(
    `SELECT * FROM schedules WHERE trigger_type = 'cron' AND enabled = 1 AND next_run_at <= ?`
  ).all(nowUnix) as ScheduleRow[]
}

export function listAllSchedules(): ScheduleRow[] {
  const db = openDb()
  return db.prepare(`SELECT * FROM schedules`).all() as ScheduleRow[]
}

/**
 * Compare-and-swap: only advances if next_run_at still matches expectedNextRunAt.
 * Uses `IS ?` instead of `= ?` because next_run_at can be NULL and
 * SQLite's `IS` handles NULL equality correctly (NULL IS NULL → true).
 */
export function advanceSchedule(
  jigId: string,
  expectedNextRunAt: number | null,
  nextRunAt: number | null,
): boolean {
  const db = openDb()
  const result = db.prepare(
    `UPDATE schedules
     SET next_run_at = ?
     WHERE jig_id = ?
       AND next_run_at IS ?
       AND enabled = 1`
  ).run(nextRunAt, jigId, expectedNextRunAt)
  return result.changes > 0
}

export function markScheduleTriggered(jigId: string, lastRunAt: number): void {
  const db = openDb()
  db.prepare(
    `UPDATE schedules SET last_run_at = ?, error = NULL WHERE jig_id = ?`
  ).run(lastRunAt, jigId)
}

export function setScheduleEnabled(jigId: string, enabled: boolean): void {
  const db = openDb()
  db.prepare(`UPDATE schedules SET enabled = ? WHERE jig_id = ?`).run(enabled ? 1 : 0, jigId)
}

export function setScheduleError(jigId: string, error: string | null): void {
  const db = openDb()
  db.prepare(`UPDATE schedules SET error = ? WHERE jig_id = ?`).run(error, jigId)
}

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

export function getCredential(key: string): string | null {
  const db = openDb()
  const row = db.prepare(`SELECT value FROM credentials WHERE key = ?`).get(key) as { value: string } | null
  return row?.value ?? null
}

export function setCredential(key: string, value: string, server: string): void {
  const db = openDb()
  db.prepare(`INSERT OR REPLACE INTO credentials (key, value, server) VALUES (?, ?, ?)`).run(key, value, server)
}

export function listCredentials(server?: string): { key: string; server: string; created_at: string }[] {
  const db = openDb()
  if (server) {
    return db.prepare(`SELECT key, server, created_at FROM credentials WHERE server = ?`).all(server) as any[]
  }
  return db.prepare(`SELECT key, server, created_at FROM credentials`).all() as any[]
}

export function deleteCredentials(server: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM credentials WHERE server = ?`).run(server)
}

// ---------------------------------------------------------------------------
// Authorized senders
// ---------------------------------------------------------------------------

export interface AuthorizedSenderRow {
  channel: string
  sender_id: string
  authorized_at: string
}

export function listAuthorizedSenders(): AuthorizedSenderRow[] {
  const db = openDb()
  return db.prepare(`SELECT * FROM authorized_senders ORDER BY channel, sender_id`).all() as AuthorizedSenderRow[]
}

export function isAuthorizedSender(channel: string, senderId: string): boolean {
  const db = openDb()
  const row = db.prepare(`SELECT 1 FROM authorized_senders WHERE channel = ? AND sender_id = ?`).get(channel, senderId)
  return row != null
}

export function addAuthorizedSender(channel: string, senderId: string): void {
  const db = openDb()
  db.prepare(`INSERT OR IGNORE INTO authorized_senders (channel, sender_id) VALUES (?, ?)`).run(channel, senderId)
}

export function removeAuthorizedSender(channel: string, senderId: string): boolean {
  const db = openDb()
  const result = db.prepare(`DELETE FROM authorized_senders WHERE channel = ? AND sender_id = ?`).run(channel, senderId)
  return result.changes > 0
}

// ---------------------------------------------------------------------------
// Settings (generic key/value, value is JSON string)
// ---------------------------------------------------------------------------

export function getSetting<T = unknown>(key: string): T | null {
  const db = openDb()
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | null
  if (!row) return null
  try { return JSON.parse(row.value) as T } catch { return null }
}

export function setSetting(key: string, value: unknown): void {
  const db = openDb()
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
  ).run(key, JSON.stringify(value))
}

// ---------------------------------------------------------------------------
// Tool permissions
// ---------------------------------------------------------------------------

export type ToolPermissionPolicy = "always" | "ask" | "never"

export interface ToolPermissionRow {
  connection: string
  tool: string
  policy: ToolPermissionPolicy
  updated_at: string
}

export function listToolPermissions(): ToolPermissionRow[] {
  const db = openDb()
  return db.prepare(`SELECT * FROM tool_permissions ORDER BY connection, tool`).all() as ToolPermissionRow[]
}

export function getToolPermission(connection: string, tool: string): ToolPermissionPolicy | null {
  const db = openDb()
  const row = db.prepare(
    `SELECT policy FROM tool_permissions WHERE connection = ? AND tool = ?`
  ).get(connection, tool) as { policy: ToolPermissionPolicy } | null
  return row?.policy ?? null
}

export function setToolPermission(connection: string, tool: string, policy: ToolPermissionPolicy): void {
  const db = openDb()
  db.prepare(
    `INSERT INTO tool_permissions (connection, tool, policy, updated_at) VALUES (?, ?, ?, datetime('now'))
     ON CONFLICT(connection, tool) DO UPDATE SET policy = excluded.policy, updated_at = datetime('now')`
  ).run(connection, tool, policy)
}

// ---------------------------------------------------------------------------
// Interrupted runs
// ---------------------------------------------------------------------------

export function markInterruptedRuns(): number {
  const db = openDb()
  db.prepare(
    `UPDATE run_steps
     SET status = 'fail',
         finished_at = datetime('now'),
         error = COALESCE(error, 'interrupted by process restart')
     WHERE run_id IN (SELECT id FROM runs WHERE status = 'running')
       AND status = 'running'`
  ).run()
  const result = db.prepare(
    `UPDATE runs SET status = 'fail', finished_at = datetime('now'), error = 'interrupted by process restart' WHERE status = 'running'`
  ).run()
  return result.changes
}

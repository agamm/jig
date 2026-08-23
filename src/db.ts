/**
 * SQLite database module — run history and step results.
 *
 * Uses bun:sqlite. Opens/creates jig.db at project root.
 * The jigs/jig_versions tables are the source of truth for jig source and
 * metadata (see services/jig-store.ts); this module owns the raw SQL surface.
 */
import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname } from "node:path"
import { DB_PATH } from "./config/paths.js"

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

/**
 * The CURRENT schema, applied verbatim to a brand-new database.
 *
 * This is a squashed baseline: the twenty incremental migrations that built it
 * during alpha were collapsed once every instance had run them, together with
 * the schema-introspection logic that existed only to let those historical
 * migrations replay harmlessly over a fresh database.
 *
 * A schema change means TWO edits: update this block (so new databases get it)
 * AND append a migration (so existing databases get it). `db.test.ts`
 * ("fresh and migrated databases converge") fails if you do only one.
 */
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
CREATE INDEX IF NOT EXISTS idx_runs_jig_id ON runs(jig_id);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status);

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
CREATE INDEX IF NOT EXISTS idx_run_steps_run_id ON run_steps(run_id);

CREATE TABLE IF NOT EXISTS step_cache (
  jig_id TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  steps TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_step_cache_jig ON step_cache(jig_id);

-- Jig source of truth. The jigs table points at the approved (active) version
-- and optionally a pending one awaiting approval; jig_versions is append-only.
CREATE TABLE IF NOT EXISTS jigs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  active_version_id INTEGER REFERENCES jig_versions(id),
  pending_version_id INTEGER REFERENCES jig_versions(id),
  created_at INTEGER NOT NULL,
  archived_at INTEGER,
  model_override TEXT,
  step_model_overrides TEXT,
  run_timeout_ms INTEGER,
  tool_timeout_ms INTEGER
);
CREATE TABLE IF NOT EXISTS jig_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jig_id TEXT NOT NULL,
  code TEXT NOT NULL,
  message TEXT,
  prompt TEXT,
  author TEXT NOT NULL,
  parent_version_id INTEGER REFERENCES jig_versions(id),
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jig_versions_jig ON jig_versions(jig_id, id DESC);

CREATE TABLE IF NOT EXISTS schedules (
  jig_id TEXT PRIMARY KEY,
  trigger_type TEXT NOT NULL,
  cron_expr TEXT,
  timezone TEXT,
  missed_strategy TEXT NOT NULL DEFAULT 'catch-up',
  next_run_at INTEGER,
  last_run_at INTEGER,
  enabled INTEGER NOT NULL DEFAULT 1,
  error TEXT
);

-- One row per (jig, calendar event) a calendar trigger has already fired for.
-- Dedup lives here rather than on a time window: a window wide enough to
-- survive a late tick is also wide enough to fire twice.
CREATE TABLE IF NOT EXISTS calendar_fires (
  jig_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  fired_at INTEGER NOT NULL,
  PRIMARY KEY (jig_id, event_id)
);
CREATE INDEX IF NOT EXISTS idx_calendar_fires_fired_at ON calendar_fires(fired_at);

CREATE TABLE IF NOT EXISTS authorized_senders (
  channel TEXT NOT NULL,
  sender_id TEXT NOT NULL,
  authorized_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (channel, sender_id)
);

-- encrypted: 0 = plaintext (pre-password), 1 = ciphertext. get/setCredential
-- wrap and unwrap transparently via src/crypto/password.ts.
CREATE TABLE IF NOT EXISTS credentials (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  server TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  encrypted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tool_permissions (
  connection TEXT NOT NULL,
  tool TEXT NOT NULL,
  policy TEXT NOT NULL CHECK(policy IN ('always', 'ask', 'never')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (connection, tool)
);

-- Any process touching jig.db appends here (CLI, API server, scheduler), so
-- the dashboard's Logs page shows everything, not just what one process saw.
CREATE TABLE IF NOT EXISTS logs (
  seq    INTEGER PRIMARY KEY AUTOINCREMENT,
  ts     INTEGER NOT NULL,
  level  TEXT NOT NULL CHECK (level IN ('info','warn','error')),
  source TEXT NOT NULL,
  msg    TEXT NOT NULL,
  payload TEXT
);
CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);

CREATE TABLE IF NOT EXISTS agent_sessions (
  session_id TEXT PRIMARY KEY,
  jig_id TEXT,
  creation_mode INTEGER NOT NULL,
  authoring_intent TEXT NOT NULL,
  conversation_history TEXT NOT NULL,
  authoring_policy TEXT NOT NULL,
  messages TEXT NOT NULL,
  events TEXT NOT NULL,
  status TEXT NOT NULL,
  metrics TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pending_ask_tool_call_id TEXT,
  pending_ask_question TEXT,
  draft_approval TEXT,
  last_event_seq INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_jig_id ON agent_sessions(jig_id);

-- Maps an inbound mail thread to the jig its failure email was about, so a
-- reply routes to that jig's authoring agent. approval 'auto' ships edits on
-- reply; 'propose' ships only on an explicit apply. reply_token is the shared
-- secret a genuine reply echoes (a spoofed From alone cannot drive edits).
CREATE TABLE IF NOT EXISTS email_threads (
  thread_id TEXT PRIMARY KEY,
  jig_id TEXT NOT NULL,
  agent_session_id TEXT,
  approval TEXT,
  reply_token TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Cross-run jig state, the store behind ctx.memory. Scoped per jig: a jig can
-- neither read nor clobber another's keys. Values are JSON written by the SDK.
-- The primary key doubles as the prefix-scan index for ctx.memory.list().
CREATE TABLE IF NOT EXISTS jig_memory (
  jig_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (jig_id, key)
);

-- Self-scheduled wake-ups behind ctx.remind(). A row is a promise to run
-- jig_id at due_at carrying payload. fired_at NULL means still pending; setting
-- it is what consumes the reminder, so the partial indexes below only ever
-- cover pending rows and stay small as the fired ones accumulate.
CREATE TABLE IF NOT EXISTS jig_reminders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jig_id TEXT NOT NULL,
  key TEXT,
  due_at INTEGER NOT NULL,
  payload TEXT,
  created_at INTEGER NOT NULL,
  fired_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_jig_reminders_due ON jig_reminders(due_at) WHERE fired_at IS NULL;
-- A caller-supplied key makes ctx.remind idempotent: re-reminding under the same
-- key reschedules rather than stacking a duplicate. Unique over PENDING rows
-- only, so the key is reusable once its reminder has fired.
CREATE UNIQUE INDEX IF NOT EXISTS idx_jig_reminders_key ON jig_reminders(jig_id, key) WHERE key IS NOT NULL AND fired_at IS NULL;

-- The AgentMail inbox owned by an email-triggered jig. Inbound mail is routed
-- by the inbox that received it (message.inbox_id), not by thread, that is
-- what separates "data for this jig" from "edit this jig", which is what a
-- reply to any other jig thread still means.
CREATE TABLE IF NOT EXISTS jig_inboxes (
  jig_id TEXT PRIMARY KEY,
  inbox_id TEXT NOT NULL UNIQUE,
  address TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`

/** Schema generation SCHEMA represents. MIGRATIONS[i] upgrades BASELINE + i to BASELINE + i + 1. */
const BASELINE_VERSION = 20

/**
 * Schema changes made after the baseline. APPEND ONLY — `PRAGMA user_version`
 * is an index into this list, so inserting or reordering makes existing
 * databases skip migrations they never ran.
 */
const MIGRATIONS: string[] = [
  // v21: drop the draft-file pointer the pre-store authoring flow used. Draft
  // code lives in jig_versions now, so this column was written and hydrated but
  // never read. (draft_approval stays — it is the live approval payload the
  // dashboard reads back after a restart.)
  `ALTER TABLE agent_sessions DROP COLUMN draft_file_path;`,
  // v22: calendar-trigger dedup. Keyed on (jig, event) so a late or repeated
  // tick cannot send the same briefing twice.
  `CREATE TABLE IF NOT EXISTS calendar_fires (
    jig_id TEXT NOT NULL,
    event_id TEXT NOT NULL,
    fired_at INTEGER NOT NULL,
    PRIMARY KEY (jig_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_calendar_fires_fired_at ON calendar_fires(fired_at);`,
  // v23: cross-run jig state (ctx.memory), self-scheduled wake-ups
  // (ctx.remind), and the per-jig AgentMail inbox that email-triggered jigs
  // receive on. Together these are what let a jig remember something now and
  // act on it later.
  `CREATE TABLE IF NOT EXISTS jig_memory (
    jig_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (jig_id, key)
  );
  CREATE TABLE IF NOT EXISTS jig_reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    jig_id TEXT NOT NULL,
    key TEXT,
    due_at INTEGER NOT NULL,
    payload TEXT,
    created_at INTEGER NOT NULL,
    fired_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_jig_reminders_due ON jig_reminders(due_at) WHERE fired_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_jig_reminders_key ON jig_reminders(jig_id, key) WHERE key IS NOT NULL AND fired_at IS NULL;
  CREATE TABLE IF NOT EXISTS jig_inboxes (
    jig_id TEXT PRIMARY KEY,
    inbox_id TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );`,
]

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

/**
 * The file opened fine — its SCHEMA is what we could not bring up to date.
 * openDb's corruption recovery must let this through: the database is intact
 * and renaming it aside would boot the instance on an empty one instead.
 */
export class SchemaError extends Error {}

export function runMigrations(db: Database, dbPath = DB_PATH) {
  const current = (db.prepare("PRAGMA user_version").get() as any)?.user_version ?? 0
  const latest = BASELINE_VERSION + MIGRATIONS.length

  // A brand-new database just received SCHEMA, which is always the CURRENT
  // schema — not the baseline generation. So it is already at `latest` and must
  // not replay migrations that would try to re-apply changes it already has.
  if (current === 0) {
    db.exec(`PRAGMA user_version = ${latest}`)
    return
  }
  if (current < BASELINE_VERSION) {
    throw new SchemaError(
      `Database schema v${current} predates the v${BASELINE_VERSION} baseline and can no longer be upgraded. ` +
        `Move ${dbPath} aside and let jig create a fresh one.`,
    )
  }

  for (let i = current - BASELINE_VERSION; i < MIGRATIONS.length; i++) {
    // Each migration runs atomically: either the schema change AND the version
    // bump land together, or the DB rolls back. A failed migration therefore
    // crashes boot cleanly — Railway marks the deploy failed and `jig update`
    // auto-rolls back. No partial state.
    db.exec("BEGIN")
    try {
      db.exec(MIGRATIONS[i])
      db.exec(`PRAGMA user_version = ${BASELINE_VERSION + i + 1}`)
      db.exec("COMMIT")
    } catch (e: any) {
      db.exec("ROLLBACK")
      throw new SchemaError(`Migration v${BASELINE_VERSION + i + 1} failed: ${e?.message ?? e}`)
    }
  }
}

let _db: Database | null = null

// Concurrent CLI + scheduler tick + API requests all touch the same SQLite
// file. WAL allows parallel reads + one writer; busy_timeout makes the
// writer queue instead of erroring with SQLITE_BUSY on collision.
function configurePragmas(db: Database): void {
  db.exec("PRAGMA journal_mode = WAL")
  db.exec("PRAGMA foreign_keys = ON")
  db.exec("PRAGMA busy_timeout = 5000")
}

export function openDb(path?: string): Database {
  if (_db) return _db
  const dbPath = path ?? DB_PATH

  // Ensure the data directory exists before bun:sqlite tries to open a file
  // in it. On Railway without a volume attached, /data doesn't exist and
  // Bun's error message "unable to open database file" is opaque.
  if (dbPath !== ":memory:") {
    const dir = dirname(dbPath)
    if (!existsSync(dir)) {
      try {
        // Holds jig.db (the credentials table lives here) — keep it owner-only.
        mkdirSync(dir, { recursive: true, mode: 0o700 })
      } catch (e: any) {
        throw new Error(
          `Can't create data directory ${dir}: ${e?.message ?? e}. ` +
            `On Railway, make sure a volume is mounted at that path.`,
        )
      }
    }
  }

  try {
    _db = new Database(dbPath)
    configurePragmas(_db)
    _db.exec(SCHEMA)
    runMigrations(_db, dbPath)
  } catch (e: any) {
    const msg = e?.message ?? String(e)
    // The file is readable; only the schema is behind or a migration failed.
    // Recovery here would rename a perfectly healthy database aside and boot
    // on an empty one — turning a deploy that must fail loudly into a green
    // deploy with no jigs, schedules, or credentials.
    if (e instanceof SchemaError) {
      try { _db?.close() } catch {}
      _db = null
      throw e
    }
    // A genuine file-not-openable error on first boot is NOT corruption —
    // don't wipe-and-retry or we'll loop. Surface the error so the process
    // exits cleanly and Railway reports deploy failed with a useful log.
    if (/unable to open database file/i.test(msg)) {
      throw new Error(
        `Can't open SQLite database at ${dbPath}: ${msg}. ` +
          `Check that the parent directory is writable (Railway: volume mounted at ${dirname(dbPath)}).`,
      )
    }
    if (dbPath !== ":memory:") {
      // Treat remaining errors as likely corruption. Move the damaged file
      // aside instead of deleting — run history, schedules, and credentials
      // may be recoverable with sqlite3 .recover, and silently destroying
      // them turns one failure into a permanent data loss.
      const backupPath = `${dbPath}.corrupt-${new Date().toISOString().replace(/[:.]/g, "-")}`
      console.error(`DB error, recreating: ${msg}. Damaged file saved to ${backupPath}`)
      try { require("fs").renameSync(dbPath, backupPath) } catch {
        try { require("fs").unlinkSync(dbPath) } catch {}
      }
      try { require("fs").unlinkSync(dbPath + "-shm") } catch {}
      try { require("fs").unlinkSync(dbPath + "-wal") } catch {}
      _db = new Database(dbPath)
      configurePragmas(_db)
      _db.exec(SCHEMA)
      runMigrations(_db, dbPath)
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

export function deleteJigLocalState(jigId: string): void {
  const db = openDb()
  const runIds = db.prepare(`SELECT id FROM runs WHERE jig_id = ?`).all(jigId) as Array<{ id: number }>
  if (runIds.length > 0) {
    const placeholders = runIds.map(() => "?").join(",")
    db.prepare(`DELETE FROM run_steps WHERE run_id IN (${placeholders})`).run(...runIds.map((row) => row.id))
  }
  db.prepare(`DELETE FROM runs WHERE jig_id = ?`).run(jigId)
  db.prepare(`DELETE FROM step_cache WHERE jig_id = ?`).run(jigId)
  db.prepare(`DELETE FROM schedules WHERE jig_id = ?`).run(jigId)
  db.prepare(`DELETE FROM agent_sessions WHERE jig_id = ?`).run(jigId)
  // Otherwise a reply to an old failure email would route to a jig that no
  // longer exists.
  db.prepare(`DELETE FROM email_threads WHERE jig_id = ?`).run(jigId)
  // Same reasoning for the jig's own state: a pending reminder would wake a jig
  // that is gone, and orphaned memory would be silently inherited by the next
  // jig to reuse the id.
  db.prepare(`DELETE FROM jig_memory WHERE jig_id = ?`).run(jigId)
  db.prepare(`DELETE FROM jig_reminders WHERE jig_id = ?`).run(jigId)
  db.prepare(`DELETE FROM jig_inboxes WHERE jig_id = ?`).run(jigId)
}

export function renameJigLocalState(oldJigId: string, newJigId: string): void {
  if (oldJigId === newJigId) return
  const db = openDb()
  db.prepare(`DELETE FROM runs WHERE jig_id = ?`).run(newJigId)
  db.prepare(`DELETE FROM step_cache WHERE jig_id = ?`).run(newJigId)
  db.prepare(`DELETE FROM schedules WHERE jig_id = ?`).run(newJigId)
  db.prepare(`UPDATE runs SET jig_id = ? WHERE jig_id = ?`).run(newJigId, oldJigId)
  db.prepare(`UPDATE step_cache SET jig_id = ? WHERE jig_id = ?`).run(newJigId, oldJigId)
  db.prepare(`UPDATE schedules SET jig_id = ? WHERE jig_id = ?`).run(newJigId, oldJigId)
  db.prepare(`UPDATE agent_sessions SET jig_id = ?, updated_at = ? WHERE jig_id = ?`).run(newJigId, Date.now(), oldJigId)
  db.prepare(`UPDATE email_threads SET jig_id = ?, updated_at = datetime('now') WHERE jig_id = ?`).run(newJigId, oldJigId)
  // A rename must carry the jig's state with it, a to-do jig that lost its
  // list and its pending reminders on rename would look like data loss.
  db.prepare(`DELETE FROM jig_memory WHERE jig_id = ?`).run(newJigId)
  db.prepare(`DELETE FROM jig_reminders WHERE jig_id = ?`).run(newJigId)
  db.prepare(`DELETE FROM jig_inboxes WHERE jig_id = ?`).run(newJigId)
  db.prepare(`UPDATE jig_memory SET jig_id = ? WHERE jig_id = ?`).run(newJigId, oldJigId)
  db.prepare(`UPDATE jig_reminders SET jig_id = ? WHERE jig_id = ?`).run(newJigId, oldJigId)
  db.prepare(`UPDATE jig_inboxes SET jig_id = ? WHERE jig_id = ?`).run(newJigId, oldJigId)
}

// ---------------------------------------------------------------------------
// Agent sessions
// ---------------------------------------------------------------------------

export interface AgentSessionRow {
  session_id: string
  jig_id: string | null
  creation_mode: number
  authoring_intent: string
  conversation_history: string
  authoring_policy: string
  messages: string
  events: string
  status: string
  metrics: string
  created_at: number
  updated_at: number
  pending_ask_tool_call_id: string | null
  pending_ask_question: string | null
  /** Approval payload the dashboard reads back after a restart. */
  draft_approval: string | null
  /** SSE replay cursor — events with seq <= this have been flushed to the client at least once. */
  last_event_seq: number
}

export function upsertAgentSession(row: AgentSessionRow): void {
  const db = openDb()
  db.prepare(
    `INSERT INTO agent_sessions (
       session_id, jig_id, creation_mode, authoring_intent,
       conversation_history, authoring_policy, messages, events,
       status, metrics, created_at, updated_at,
       pending_ask_tool_call_id, pending_ask_question, draft_approval, last_event_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       jig_id = excluded.jig_id,
       creation_mode = excluded.creation_mode,
       authoring_intent = excluded.authoring_intent,
       conversation_history = excluded.conversation_history,
       authoring_policy = excluded.authoring_policy,
       messages = excluded.messages,
       events = excluded.events,
       status = excluded.status,
       metrics = excluded.metrics,
       created_at = excluded.created_at,
       updated_at = excluded.updated_at,
       pending_ask_tool_call_id = excluded.pending_ask_tool_call_id,
       pending_ask_question = excluded.pending_ask_question,
       draft_approval = excluded.draft_approval,
       last_event_seq = excluded.last_event_seq`
  ).run(
    row.session_id,
    row.jig_id,
    row.creation_mode,
    row.authoring_intent,
    row.conversation_history,
    row.authoring_policy,
    row.messages,
    row.events,
    row.status,
    row.metrics,
    row.created_at,
    row.updated_at,
    row.pending_ask_tool_call_id,
    row.pending_ask_question,
    row.draft_approval,
    row.last_event_seq,
  )
}

export function getAgentSession(sessionId: string): AgentSessionRow | null {
  const db = openDb()
  return db.prepare(`SELECT * FROM agent_sessions WHERE session_id = ?`).get(sessionId) as AgentSessionRow | null
}

export function listAgentSessions(): AgentSessionRow[] {
  const db = openDb()
  return db.prepare(`SELECT * FROM agent_sessions ORDER BY updated_at DESC`).all() as AgentSessionRow[]
}

export function deleteAgentSession(sessionId: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM agent_sessions WHERE session_id = ?`).run(sessionId)
}

/**
 * Returns true if any agent session is actively claiming this jig (status in
 * thinking/tool-calling/waiting). Used as the v12 jig-lock check. O(1) via the
 * existing idx_agent_sessions_jig_id index rather than scanning the table.
 */
export function jigHasActiveSession(jigId: string, excludeSessionId?: string): boolean {
  const db = openDb()
  const stmt = excludeSessionId
    ? db.prepare(
        `SELECT 1 FROM agent_sessions
          WHERE jig_id = ? AND session_id != ?
            AND status IN ('thinking','tool-calling','waiting')
          LIMIT 1`,
      )
    : db.prepare(
        `SELECT 1 FROM agent_sessions
          WHERE jig_id = ?
            AND status IN ('thinking','tool-calling','waiting')
          LIMIT 1`,
      )
  const row = excludeSessionId ? stmt.get(jigId, excludeSessionId) : stmt.get(jigId)
  return row != null
}

// ---------------------------------------------------------------------------
// Schedules
// ---------------------------------------------------------------------------

export interface ScheduleRow {
  jig_id: string
  trigger_type: "cron" | "webhook" | "calendar" | "email"
  cron_expr: string | null
  timezone: string | null
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


// ---------------------------------------------------------------------------
// Calendar-trigger fire dedup
// ---------------------------------------------------------------------------

/** Event ids this jig has already fired for since `sinceMs`. */
export function listCalendarFires(jigId: string, sinceMs: number): Set<string> {
  const db = openDb()
  const rows = db.prepare(
    `SELECT event_id FROM calendar_fires WHERE jig_id = ? AND fired_at >= ?`
  ).all(jigId, sinceMs) as { event_id: string }[]
  return new Set(rows.map((r) => r.event_id))
}

/** Idempotent: a tick that fired and died before recording retries safely. */
export function recordCalendarFire(jigId: string, eventId: string, firedAt: number): void {
  const db = openDb()
  db.prepare(
    `INSERT INTO calendar_fires (jig_id, event_id, fired_at) VALUES (?, ?, ?)
     ON CONFLICT(jig_id, event_id) DO NOTHING`
  ).run(jigId, eventId, firedAt)
}

/** Drop fires older than `beforeMs`; the table is a dedup ledger, not history. */
export function pruneCalendarFires(beforeMs: number): void {
  const db = openDb()
  db.prepare(`DELETE FROM calendar_fires WHERE fired_at < ?`).run(beforeMs)
}

export function upsertSchedule(
  jigId: string,
  triggerType: "cron" | "webhook" | "calendar" | "email",
  cronExpr: string | null,
  missedStrategy: "catch-up" | "skip",
  nextRunAt: number | null,
  error: string | null,
  timezone: string | null = null,
): void {
  const db = openDb()
  db.prepare(
    `INSERT INTO schedules (jig_id, trigger_type, cron_expr, missed_strategy, next_run_at, error, timezone)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(jig_id) DO UPDATE SET
       trigger_type = excluded.trigger_type,
       cron_expr = excluded.cron_expr,
       missed_strategy = excluded.missed_strategy,
       next_run_at = excluded.next_run_at,
       error = excluded.error,
       timezone = excluded.timezone`
  ).run(jigId, triggerType, cronExpr, missedStrategy, nextRunAt, error, timezone)
}

export function deleteSchedule(jigId: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM schedules WHERE jig_id = ?`).run(jigId)
}

/** Enabled cron schedules regardless of due time — used to name what a lock paused. */
export function listEnabledCronSchedules(): ScheduleRow[] {
  const db = openDb()
  return db.prepare(
    `SELECT * FROM schedules WHERE trigger_type = 'cron' AND enabled = 1 ORDER BY jig_id`
  ).all() as ScheduleRow[]
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

/**
 * Read a credential. If the row is encrypted, decrypt with the in-memory
 * data key; throws LockedError if jig is locked. Plaintext rows (legacy) are
 * returned as-is so fresh-install OAuth flows work before a password is set.
 */
export function getCredential(key: string): string | null {
  const { isUnlocked, decrypt, LockedError } = require("./crypto/password.js") as typeof import("./crypto/password.js")
  const db = openDb()
  const row = db
    .prepare(`SELECT value, encrypted FROM credentials WHERE key = ?`)
    .get(key) as { value: string; encrypted: number } | null
  if (!row) return null
  if (row.encrypted === 0) return row.value
  if (!isUnlocked()) throw new LockedError()
  return decrypt(row.value)
}

/**
 * Write a credential. Encrypts the value if jig is unlocked; stores plaintext
 * otherwise (pre-password-set state). A later setPassword() migrates any
 * plaintext rows to encrypted in place.
 */
export function setCredential(key: string, value: string, server: string): void {
  const { isUnlocked, encrypt } = require("./crypto/password.js") as typeof import("./crypto/password.js")
  const db = openDb()
  if (isUnlocked()) {
    const ct = encrypt(value)
    db.prepare(
      `INSERT OR REPLACE INTO credentials (key, value, server, encrypted) VALUES (?, ?, ?, 1)`,
    ).run(key, ct, server)
  } else {
    db.prepare(
      `INSERT OR REPLACE INTO credentials (key, value, server, encrypted) VALUES (?, ?, ?, 0)`,
    ).run(key, value, server)
  }
}

export function listCredentials(server?: string): { key: string; server: string; created_at: string }[] {
  const db = openDb()
  if (server) {
    return db.prepare(`SELECT key, server, created_at FROM credentials WHERE server = ?`).all(server) as any[]
  }
  return db.prepare(`SELECT key, server, created_at FROM credentials`).all() as any[]
}

export interface RawCredentialRow {
  key: string
  value: string
  server: string
  encrypted: number
}

/**
 * Every credential row exactly as stored, ciphertext and all.
 *
 * Backup needs this rather than getCredential(): decrypting would require the
 * instance to be unlocked and would put plaintext secrets in the archive. The
 * ciphertext travels with the salt instead, so the file holds nothing readable
 * without the password that made it.
 */
export function listRawCredentials(): RawCredentialRow[] {
  return openDb()
    .prepare(`SELECT key, value, server, encrypted FROM credentials ORDER BY key`)
    .all() as RawCredentialRow[]
}

/** Write a credential row verbatim, bypassing encryption. Restore only. */
export function putRawCredential(row: RawCredentialRow): void {
  openDb()
    .prepare(`INSERT OR REPLACE INTO credentials (key, value, server, encrypted) VALUES (?, ?, ?, ?)`)
    .run(row.key, row.value, row.server, row.encrypted)
}

/** Every settings row, undecoded. Backup carries settings through opaquely. */
export function listRawSettings(): { key: string; value: string }[] {
  return openDb().prepare(`SELECT key, value FROM settings ORDER BY key`).all() as { key: string; value: string }[]
}

/**
 * One settings row, undecoded.
 *
 * getSetting() JSON.parses and returns null when that throws. The crypto module
 * keeps its own private accessors that write the salt and canary as RAW strings,
 * so reading those through getSetting() silently yields null. Anything touching
 * password.salt / password.canary must come through here.
 */
export function getRawSetting(key: string): string | null {
  const row = openDb().prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as
    | { value: string }
    | undefined
  return row?.value ?? null
}

/** Write a settings row verbatim, keeping the stored JSON encoding as-is. */
export function putRawSetting(key: string, value: string): void {
  openDb()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`
    )
    .run(key, value)
}

export function deleteCredentials(server: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM credentials WHERE server = ?`).run(server)
}

export function deleteCredential(key: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM credentials WHERE key = ?`).run(key)
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
// Email threads — correlate an inbound mail reply back to the jig it concerns
// ---------------------------------------------------------------------------

/** How replies on this thread are treated. 'auto' (or null, legacy default):
 * owner-solicited, edits ship on reply. 'propose': unsolicited auto-repair fix
 * that ships only on an explicit "apply". */
export type EmailThreadApproval = "auto" | "propose"

export interface EmailThreadRow {
  thread_id: string
  jig_id: string
  agent_session_id: string | null
  approval: EmailThreadApproval | null
  /** Shared secret echoed by a genuine reply. NULL for pre-v20 threads. */
  reply_token: string | null
  created_at: string
  updated_at: string
}

/** Remember that `threadId` (an AgentMail thread) is about `jigId`. Upsert so a
 *  repeated failure email for the same jig keeps one row per thread. Optionally
 *  set the approval mode ('propose' for auto-repair proposals) and the per-thread
 *  reply token that inbound replies must echo. */
export function recordEmailThread(
  threadId: string,
  jigId: string,
  approval: EmailThreadApproval = "auto",
  replyToken: string | null = null,
): void {
  const db = openDb()
  db.prepare(
    `INSERT INTO email_threads (thread_id, jig_id, approval, reply_token) VALUES (?, ?, ?, ?)
     ON CONFLICT(thread_id) DO UPDATE SET jig_id = excluded.jig_id, approval = excluded.approval,
       reply_token = COALESCE(excluded.reply_token, email_threads.reply_token), updated_at = datetime('now')`
  ).run(threadId, jigId, approval, replyToken)
}

export function getEmailThread(threadId: string): EmailThreadRow | null {
  const db = openDb()
  return db.prepare(`SELECT * FROM email_threads WHERE thread_id = ?`).get(threadId) as EmailThreadRow | null
}

/** Attach (or clear) the live authoring session driving edits for this thread. */
export function setEmailThreadSession(threadId: string, sessionId: string | null): void {
  const db = openDb()
  db.prepare(
    `UPDATE email_threads SET agent_session_id = ?, updated_at = datetime('now') WHERE thread_id = ?`
  ).run(sessionId, threadId)
}

// ---------------------------------------------------------------------------
// Jig memory, the store behind ctx.memory
// ---------------------------------------------------------------------------

/**
 * Caps exist because nothing else bounds this table: a jig that writes a key
 * per run grows the database forever, and jig.db sits on the same volume as
 * credentials and run history. Both limits are generous for the intended use
 * (a to-do list, a seen-ids set) and are enforced at the SDK boundary so the
 * jig author gets a real error instead of a silently truncated write.
 */
export const MEMORY_MAX_VALUE_BYTES = 64 * 1024
export const MEMORY_MAX_KEYS_PER_JIG = 1000

export interface JigMemoryRow {
  key: string
  value: string
  updated_at: number
}

export function getJigMemory(jigId: string, key: string): string | null {
  const db = openDb()
  const row = db.prepare(
    `SELECT value FROM jig_memory WHERE jig_id = ? AND key = ?`
  ).get(jigId, key) as { value: string } | undefined
  return row?.value ?? null
}

/** Upsert. Returns false when the jig is already at MEMORY_MAX_KEYS_PER_JIG and
 *  this would add a NEW key; overwriting an existing key always succeeds. */
export function setJigMemory(jigId: string, key: string, value: string): boolean {
  const db = openDb()
  const exists = db.prepare(
    `SELECT 1 FROM jig_memory WHERE jig_id = ? AND key = ?`
  ).get(jigId, key) != null
  if (!exists && countJigMemory(jigId) >= MEMORY_MAX_KEYS_PER_JIG) return false
  db.prepare(
    `INSERT INTO jig_memory (jig_id, key, value, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(jig_id, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`
  ).run(jigId, key, value, Date.now())
  return true
}

/** True when a row was actually removed. */
export function deleteJigMemory(jigId: string, key: string): boolean {
  const db = openDb()
  return db.prepare(`DELETE FROM jig_memory WHERE jig_id = ? AND key = ?`).run(jigId, key).changes > 0
}

/** Keys in insertion-independent (lexical) order so listings are stable. */
export function listJigMemory(jigId: string, prefix?: string): JigMemoryRow[] {
  const db = openDb()
  if (prefix != null && prefix !== "") {
    // Escape LIKE wildcards so a key prefix containing % or _ matches literally.
    const escaped = prefix.replace(/[\\%_]/g, (c) => `\\${c}`)
    return db.prepare(
      `SELECT key, value, updated_at FROM jig_memory
       WHERE jig_id = ? AND key LIKE ? ESCAPE '\\' ORDER BY key`
    ).all(jigId, `${escaped}%`) as JigMemoryRow[]
  }
  return db.prepare(
    `SELECT key, value, updated_at FROM jig_memory WHERE jig_id = ? ORDER BY key`
  ).all(jigId) as JigMemoryRow[]
}

export function countJigMemory(jigId: string): number {
  const db = openDb()
  const row = db.prepare(`SELECT COUNT(*) AS n FROM jig_memory WHERE jig_id = ?`).get(jigId) as { n: number }
  return row.n
}

export function clearJigMemory(jigId: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM jig_memory WHERE jig_id = ?`).run(jigId)
}

// ---------------------------------------------------------------------------
// Jig reminders, the store behind ctx.remind
// ---------------------------------------------------------------------------

export interface JigReminderRow {
  id: number
  jig_id: string
  key: string | null
  due_at: number
  payload: string | null
  created_at: number
  fired_at: number | null
}

/**
 * Schedule a wake-up. With a `key`, this replaces that key's pending reminder
 * rather than adding a second one, so a jig re-reading the same to-do on every
 * run reschedules it instead of stacking duplicates. Returns the row id.
 */
export function scheduleJigReminder(
  jigId: string,
  dueAt: number,
  payload: string | null,
  key: string | null = null,
): number {
  const db = openDb()
  if (key != null) {
    db.prepare(
      `DELETE FROM jig_reminders WHERE jig_id = ? AND key = ? AND fired_at IS NULL`
    ).run(jigId, key)
  }
  const res = db.prepare(
    `INSERT INTO jig_reminders (jig_id, key, due_at, payload, created_at) VALUES (?, ?, ?, ?, ?)`
  ).run(jigId, key, dueAt, payload, Date.now())
  return Number(res.lastInsertRowid)
}

/** Pending reminders due at or before `nowMs`, oldest first, grouped-ready. */
export function listDueJigReminders(nowMs: number): JigReminderRow[] {
  const db = openDb()
  return db.prepare(
    `SELECT * FROM jig_reminders WHERE fired_at IS NULL AND due_at <= ? ORDER BY due_at, id`
  ).all(nowMs) as JigReminderRow[]
}

/**
 * Consume reminders, returning the ids this call actually claimed. Guarded on
 * fired_at IS NULL so a concurrent tick that already claimed some cannot
 * double-fire them, and RETURNING (rather than a count) is what lets the
 * caller fire exactly the reminders it won, not the ones it merely asked for.
 */
export function markJigRemindersFired(ids: number[], firedAt: number): number[] {
  if (ids.length === 0) return []
  const db = openDb()
  const placeholders = ids.map(() => "?").join(", ")
  const rows = db.prepare(
    `UPDATE jig_reminders SET fired_at = ? WHERE fired_at IS NULL AND id IN (${placeholders}) RETURNING id`
  ).all(firedAt, ...ids) as { id: number }[]
  return rows.map((r) => r.id)
}

export function listPendingJigReminders(jigId: string): JigReminderRow[] {
  const db = openDb()
  return db.prepare(
    `SELECT * FROM jig_reminders WHERE jig_id = ? AND fired_at IS NULL ORDER BY due_at, id`
  ).all(jigId) as JigReminderRow[]
}

/** Cancel a pending reminder by its key. True when one was actually cancelled. */
export function cancelJigReminder(jigId: string, key: string): boolean {
  const db = openDb()
  return db.prepare(
    `DELETE FROM jig_reminders WHERE jig_id = ? AND key = ? AND fired_at IS NULL`
  ).run(jigId, key).changes > 0
}

/** Drop fired reminders older than `beforeMs`. Pending ones are never pruned,
 *  however far out they are dated, a reminder set for next year must survive. */
export function pruneJigReminders(beforeMs: number): number {
  const db = openDb()
  return db.prepare(
    `DELETE FROM jig_reminders WHERE fired_at IS NOT NULL AND fired_at < ?`
  ).run(beforeMs).changes
}

export function clearJigReminders(jigId: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM jig_reminders WHERE jig_id = ?`).run(jigId)
}

// ---------------------------------------------------------------------------
// Per-jig AgentMail inboxes, the routing table for email-triggered jigs
// ---------------------------------------------------------------------------

export interface JigInboxRow {
  jig_id: string
  inbox_id: string
  address: string
  created_at: number
}

export function getJigInbox(jigId: string): JigInboxRow | null {
  const db = openDb()
  return db.prepare(`SELECT * FROM jig_inboxes WHERE jig_id = ?`).get(jigId) as JigInboxRow | null
}

/** The router lookup: which jig owns the inbox this message arrived in. */
export function getJigByInboxId(inboxId: string): JigInboxRow | null {
  const db = openDb()
  return db.prepare(`SELECT * FROM jig_inboxes WHERE inbox_id = ?`).get(inboxId) as JigInboxRow | null
}

export function recordJigInbox(jigId: string, inboxId: string, address: string): void {
  const db = openDb()
  db.prepare(
    `INSERT INTO jig_inboxes (jig_id, inbox_id, address, created_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(jig_id) DO UPDATE SET inbox_id = excluded.inbox_id, address = excluded.address`
  ).run(jigId, inboxId, address, Date.now())
}

/** Forget the local mapping. The AgentMail inbox itself is left alone, mail
 *  already delivered there stays retrievable, and deleting it would be
 *  irreversible from a routine like archiving a jig. */
export function deleteJigInbox(jigId: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM jig_inboxes WHERE jig_id = ?`).run(jigId)
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

/**
 * Retention: delete finished runs (and their steps) older than `days`.
 * Called from the scheduler's daily maintenance pass so a 24/7 instance
 * doesn't grow the runs/run_steps tables without bound.
 */
export function pruneOldRuns(days: number): { runs: number; steps: number } {
  const db = openDb()
  const cutoff = `-${Math.max(1, Math.floor(days))} days`
  const steps = db.prepare(
    `DELETE FROM run_steps WHERE run_id IN (
       SELECT id FROM runs WHERE finished_at IS NOT NULL AND finished_at < datetime('now', ?)
     )`
  ).run(cutoff).changes
  const runs = db.prepare(
    `DELETE FROM runs WHERE finished_at IS NOT NULL AND finished_at < datetime('now', ?)`
  ).run(cutoff).changes
  return { runs, steps }
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

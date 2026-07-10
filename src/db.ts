/**
 * SQLite database module — run history and step results.
 *
 * Uses bun:sqlite. Opens/creates jig.db at project root.
 * Discovery (discoverJigs) is the source of truth for jig metadata.
 * This module only stores execution history.
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
  draft_file_path TEXT,
  draft_approval TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_jig_id ON agent_sessions(jig_id);
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
  // v8: per-row encryption flag on credentials. 0 = plaintext (legacy), 1 = ciphertext.
  // Row values are encrypted in service mode once a system password is set;
  // getCredential/setCredential wrap/unwrap transparently via src/crypto/password.ts.
  `ALTER TABLE credentials ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0;`,
  // v9: persistent log buffer. Any process touching jig.db can append (CLI,
  // API server, scheduler). The /api/logs endpoint reads from here so the
  // Logs page shows everything, not just whatever the API-server process
  // saw in its local ring buffer.
  `CREATE TABLE IF NOT EXISTS logs (
     seq    INTEGER PRIMARY KEY AUTOINCREMENT,
     ts     INTEGER NOT NULL,
     level  TEXT NOT NULL CHECK (level IN ('info','warn','error')),
     source TEXT NOT NULL,
     msg    TEXT NOT NULL
   );
   CREATE INDEX IF NOT EXISTS idx_logs_ts ON logs(ts DESC);`,
  // v10: cron timezone. Railway runs in UTC by default; schedules should keep
  // the timezone used to compute next_run_at so local-time cron definitions do
  // not silently drift.
  `ALTER TABLE schedules ADD COLUMN timezone TEXT;`,
  // v11: persist authoring agent sessions/drafts so under-construction jigs
  // survive dashboard reloads and API server restarts.
  `CREATE TABLE IF NOT EXISTS agent_sessions (
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
     draft_file_path TEXT,
     draft_approval TEXT
   );
   CREATE INDEX IF NOT EXISTS idx_agent_sessions_jig_id ON agent_sessions(jig_id);`,
  // v12: code-as-versions rehaul. Jig source moves out of filesystem files
  // into jig_versions. Each jig has a pointer to the active version and
  // optionally a pointer to a pending (unapproved) version. Approve moves
  // active to pending. Drafts during one session overwrite; only approved
  // versions become durable history. SSE resume cursor added to sessions.
  `CREATE TABLE IF NOT EXISTS jigs (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     active_version_id INTEGER REFERENCES jig_versions(id),
     pending_version_id INTEGER REFERENCES jig_versions(id),
     created_at INTEGER NOT NULL,
     archived_at INTEGER
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
   ALTER TABLE agent_sessions ADD COLUMN last_event_seq INTEGER NOT NULL DEFAULT 0;`,
  // v13: structured payloads on log entries. Session-log events (runner, sdk.llm,
  // sdk.agent, authoring.*) now mirror into the logs table with a redacted JSON
  // payload so the dashboard's Logs page can show LLM/tool details from a remote
  // Railway deploy — not just whatever made it to console.log.
  `ALTER TABLE logs ADD COLUMN payload TEXT;`,
  // v14: per-jig model override. NULL = use jig code's declared model (or the
  // global default). When set, the dashboard's override wins over jig code but
  // still below per-step / per-call options. See SDK precedence in jig.ts.
  `ALTER TABLE jigs ADD COLUMN model_override TEXT;`,
  // v15: per-step model overrides. JSON object keyed by step seq (1-indexed):
  // {"3": "openai/gpt-5"}. Dashboard sets one entry when the user clicks the
  // llm chip in a specific step and picks a model. Reads at run start, pushed
  // into ctx.step's model resolution. Higher precedence than per-jig override.
  `ALTER TABLE jigs ADD COLUMN step_model_overrides TEXT;`,
  // v16: per-jig timeout overrides (ms). NULL = use the global env default
  // (JIG_RUN_TIMEOUT_MS / JIG_MCP_TOOL_TIMEOUT_MS). Lets a jig with a
  // legitimately long-running tool call (big Apify actor, large email fetch)
  // raise its ceiling from the dashboard without touching env config.
  `ALTER TABLE jigs ADD COLUMN run_timeout_ms INTEGER;
   ALTER TABLE jigs ADD COLUMN tool_timeout_ms INTEGER;`,
  // v17: map an inbound mail thread to the jig its failure email was about, so a
  // reply to that email (delivered via the AgentMail webhook) can be routed to
  // the right jig's authoring agent. agent_session_id remembers the live editing
  // session so a back-and-forth thread continues the same session.
  `CREATE TABLE IF NOT EXISTS email_threads (
     thread_id TEXT PRIMARY KEY,
     jig_id TEXT NOT NULL,
     agent_session_id TEXT,
     created_at TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at TEXT NOT NULL DEFAULT (datetime('now'))
   );`,
  // v18: Resend was removed as a notification channel (AgentMail is now the
  // only email channel). Drop its orphaned credential + settings rows so a dead
  // API key isn't left sitting in the DB.
  `DELETE FROM credentials WHERE server = 'resend';
   DELETE FROM settings WHERE key = 'resend';`,
  // v19: remember whether a thread's edits are owner-solicited ('auto', the
  // default — replies ship immediately) or an unsolicited auto-repair proposal
  // ('propose' — the fix ships only on an explicit "apply"). Persisting it on
  // the thread keeps the proposal gate intact across revisions and questions,
  // not just the first reply.
  `ALTER TABLE email_threads ADD COLUMN approval TEXT;`,
  // v20: per-thread reply token. Reply-to-edit was authorized only by the (SMTP-
  // spoofable) From header. The token is a shared secret we place in the outbound
  // email's subject + body footer; a genuine reply echoes it, so a spoofed From
  // alone can no longer drive edits. NULL for pre-v20 threads (grandfathered —
  // they fall back to the From-only check).
  `ALTER TABLE email_threads ADD COLUMN reply_token TEXT;`,
]

// ---------------------------------------------------------------------------
// Database singleton
// ---------------------------------------------------------------------------

function runMigrations(db: Database) {
  const current = (db.prepare("PRAGMA user_version").get() as any)?.user_version ?? 0
  for (let i = current; i < MIGRATIONS.length; i++) {
    // Each migration runs atomically: either the schema change AND the version
    // bump land together, or the DB is rolled back to its pre-migration state.
    // A failed migration therefore crashes boot cleanly — Railway marks the
    // deploy failed and `jig update` auto-rolls back. No partial state.
    db.exec("BEGIN")
    try {
      db.exec(MIGRATIONS[i])
      db.exec(`PRAGMA user_version = ${i + 1}`)
      db.exec("COMMIT")
    } catch (e: any) {
      db.exec("ROLLBACK")
      // Fresh DBs get the full current SCHEMA before historical migrations run,
      // so early ALTER/CREATE migrations can fail on already-present schema.
      // Skip forward only when the schema structurally shows the migration's
      // work is already done — never by matching the engine's error prose,
      // where a phrasing change or coincidental wording would silently mask a
      // real migration failure.
      if (migrationAlreadyApplied(db, MIGRATIONS[i])) {
        db.exec(`PRAGMA user_version = ${i + 1}`)
        continue
      }
      throw new Error(`Migration ${i + 1} failed: ${e?.message ?? e}`)
    }
  }
}

/**
 * The migration's intended END STATE is already present in the schema, checked
 * against sqlite_master / PRAGMA table_info. DDL statements fold into one
 * expected state per schema object with last-statement-wins, so a
 * drop-then-recreate (e.g. v6's idx_step_cache_jig) resolves to "present"
 * rather than contradicting itself statement-by-statement. Parses only our own
 * migration SQL (a closed set this file authors). DML (INSERT/UPDATE/DELETE)
 * has no "already applied" state to verify, so it neither confirms nor denies;
 * a migration with no verifiable DDL is never skipped.
 */
function migrationAlreadyApplied(db: Database, sql: string): boolean {
  const expected = new Map<string, { present: boolean; exists: () => boolean }>()
  for (const raw of sql.split(";")) {
    const statement = raw.trim()
    if (!statement) continue
    let m: RegExpMatchArray | null
    if ((m = statement.match(/^ALTER\s+TABLE\s+(\w+)\s+(ADD|DROP)\s+COLUMN\s+(\w+)/i))) {
      const [, table, verb, column] = m
      expected.set(`column:${table}.${column}`, {
        present: verb.toUpperCase() === "ADD",
        exists: () => tableHasColumn(db, table, column),
      })
    } else if ((m = statement.match(/^(CREATE|DROP)\s+(?:UNIQUE\s+)?(TABLE|INDEX)\s+(?:IF\s+(?:NOT\s+)?EXISTS\s+)?(\w+)/i))) {
      const [, verb, kind, name] = m
      expected.set(`${kind.toLowerCase()}:${name}`, {
        present: verb.toUpperCase() === "CREATE",
        exists: () => schemaObjectExists(db, kind.toLowerCase(), name),
      })
    }
  }
  if (expected.size === 0) return false
  for (const { present, exists } of expected.values()) {
    if (exists() !== present) return false
  }
  return true
}

function tableHasColumn(db: Database, table: string, column: string): boolean {
  try {
    const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string }[]
    return cols.some((c) => c.name === column)
  } catch {
    return false
  }
}

function schemaObjectExists(db: Database, type: string, name: string): boolean {
  return db.prepare(`SELECT 1 FROM sqlite_master WHERE type = ? AND name = ?`).get(type, name) != null
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
        mkdirSync(dir, { recursive: true })
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
    runMigrations(_db)
  } catch (e: any) {
    const msg = e?.message ?? String(e)
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
  /** @deprecated v12: drafts live in jig_versions now. Column kept for back-compat. */
  draft_file_path: string | null
  /** @deprecated v12: drafts live in jig_versions now. Column kept for back-compat. */
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
       pending_ask_tool_call_id, pending_ask_question, draft_file_path, draft_approval, last_event_seq
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
       draft_file_path = excluded.draft_file_path,
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
    row.draft_file_path,
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
  trigger_type: "cron" | "webhook"
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

export function upsertSchedule(
  jigId: string,
  triggerType: "cron" | "webhook",
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

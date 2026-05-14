/**
 * Unified log stream for jig — CLI, API server, and scheduler all append
 * to the same SQLite `logs` table. The dashboard's /api/logs endpoint
 * reads from there, so the Logs page is authoritative regardless of which
 * process produced the output.
 *
 * Why SQLite, not an in-memory ring buffer: jig runs things in multiple
 * processes (the API server, `jig run` via CLI, ad-hoc scripts). An
 * in-memory buffer only sees what *its own* process wrote — CLI runs
 * would never appear on the dashboard. A shared DB table is the only
 * thing every process can reach.
 *
 * Writes are synchronous (WAL mode, single statement, sub-ms) and still
 * print to the underlying stdout/stderr so nothing regresses for anyone
 * tailing platform logs.
 *
 * Retention: the most recent MAX_RETAINED entries. Pruned opportunistically
 * after each insert — no background task needed.
 *
 * Install happens at module eval time so importing this first in any entry
 * point (server.ts, cli.ts) captures subsequent modules' load-time logs too.
 */
import { openDb } from "../db.js"

const MAX_RETAINED = 5000

export type LogLevel = "info" | "warn" | "error"
export interface LogEntry {
  seq: number
  ts: number
  level: LogLevel
  source: string
  msg: string
  /**
   * Redacted JSON payload for structured (session-log) entries, or NULL for
   * plain console.log rows. The dashboard offers a per-row expander to inspect
   * this — it's where LLM prompts/responses, tool args, and tool results live.
   */
  payload: string | null
}

/**
 * Per-process tag. Entry points declare themselves via JIG_LOG_SOURCE; no
 * filename-sniffing. Falls back to "jig" if the caller didn't set one,
 * which is still useful (you know it's a jig process, just not which).
 */
const SOURCE = process.env.JIG_LOG_SOURCE || "jig"

function formatArg(a: unknown): string {
  if (a instanceof Error) return a.stack ?? `${a.name}: ${a.message}`
  if (typeof a === "string") return a
  try { return JSON.stringify(a) } catch { return String(a) }
}

let insertCount = 0
const PRUNE_EVERY = 200

function insertLog(level: LogLevel, msg: string, payload: string | null): void {
  try {
    const db = openDb()
    db.prepare("INSERT INTO logs (ts, level, source, msg, payload) VALUES (?, ?, ?, ?, ?)")
      .run(Date.now(), level, SOURCE, msg, payload)
    if (++insertCount % PRUNE_EVERY === 0) {
      // Retain the most recent MAX_RETAINED rows. The inner SELECT returns
      // exactly the `seq` values we want to keep; the outer DELETE drops
      // everything else. Both sides use the PRIMARY KEY index so the cost
      // is O(rows-to-delete), not O(n).
      db.prepare(
        "DELETE FROM logs WHERE seq NOT IN (SELECT seq FROM logs ORDER BY seq DESC LIMIT ?)"
      ).run(MAX_RETAINED)
    }
  } catch {
    // Log capture must never break the caller. If the DB isn't open yet
    // (very early boot before openDb has run), the log is just lost —
    // acceptable tradeoff vs crashing on a console.log.
  }
}

function record(level: LogLevel, args: unknown[]): void {
  insertLog(level, args.map(formatArg).join(" "), null)
}

/**
 * Append a structured log row with a JSON payload. Used by session-log.ts to
 * mirror runner/agent/llm events into the dashboard-visible logs table.
 *
 * The caller is responsible for redaction — payload is stored verbatim.
 */
export function recordStructured(level: LogLevel, msg: string, payload: string | null): void {
  insertLog(level, msg, payload)
}

let installed = false

export function installLogCapture(): void {
  if (installed) return
  installed = true

  const origLog = console.log.bind(console)
  const origWarn = console.warn.bind(console)
  const origError = console.error.bind(console)
  const origInfo = console.info.bind(console)

  console.log = (...args: unknown[]) => { record("info", args); origLog(...args) }
  console.info = (...args: unknown[]) => { record("info", args); origInfo(...args) }
  console.warn = (...args: unknown[]) => { record("warn", args); origWarn(...args) }
  console.error = (...args: unknown[]) => { record("error", args); origError(...args) }

  process.on("uncaughtException", (err) => {
    record("error", [`[${SOURCE}] uncaughtException`, err])
  })
  process.on("unhandledRejection", (reason) => {
    record("error", [`[${SOURCE}] unhandledRejection`, reason])
  })

  record("info", [`[log-buffer] capture installed (source=${SOURCE})`])
}

export function getLogs(sinceSeq = 0): LogEntry[] {
  try {
    const db = openDb()
    const rows = db.prepare(
      "SELECT seq, ts, level, source, msg, payload FROM logs WHERE seq > ? ORDER BY seq ASC LIMIT ?"
    ).all(sinceSeq, MAX_RETAINED) as LogEntry[]
    return rows
  } catch {
    return []
  }
}

export function clearLogs(): void {
  try {
    const db = openDb()
    db.prepare("DELETE FROM logs").run()
  } catch {}
  record("info", [`[log-buffer] cleared by ${SOURCE}`])
}

installLogCapture()

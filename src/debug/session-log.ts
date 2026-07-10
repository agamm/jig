import { appendFile, mkdir } from "node:fs/promises"
import { dirname, basename, join } from "node:path"
import { DATA_DIR } from "../config/paths.js"
import { recordStructured, type LogLevel } from "../server/log-buffer.js"
import { redact } from "./redact.js"

export const SESSION_LOG_PATH = join(DATA_DIR, "jig.log")

let queue: string[] = []
let flushPending = false

function sanitize(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    }
  }
  if (typeof value === "bigint") return value.toString()
  return value
}

function stringifyLine(entry: Record<string, unknown>): string {
  try {
    return JSON.stringify(entry, (_, value) => sanitize(value))
  } catch (error) {
    return JSON.stringify({
      ts: new Date().toISOString(),
      pid: process.pid,
      type: "session-log-error",
      message: "Failed to serialize log entry",
      error: sanitize(error),
    })
  }
}

async function flush() {
  const batch = queue
  queue = []
  flushPending = false
  try {
    await mkdir(dirname(SESSION_LOG_PATH), { recursive: true })
    await appendFile(SESSION_LOG_PATH, batch.join(""))
  } catch {}
}

// ---------------------------------------------------------------------------
// SQLite mirror — what makes session events visible on the dashboard remotely
// ---------------------------------------------------------------------------

// Order matters: jig identity / model / round / tool first so the most
// useful context shows up before the noisier fields.
const HEADLINE_KEYS = [
  "jigPath",
  "jigId",
  "jigName",
  "sessionId",
  "model",
  "round",
  "tool",
  "mode",
  "runType",
  "finishReason",
  "status",
  "durationMs",
] as const

const MAX_PAYLOAD_BYTES = 64 * 1024

function shortValue(v: unknown): string {
  if (typeof v === "string") return v.length > 80 ? v.slice(0, 77) + "…" : v
  try {
    const s = JSON.stringify(v)
    return s.length > 80 ? s.slice(0, 77) + "…" : s
  } catch {
    return String(v)
  }
}

function deriveHeadline(entry: Record<string, unknown>): { msg: string; level: LogLevel } {
  const source = String(entry.source ?? entry.type ?? "session")
  const event = String(entry.event ?? "?")
  const parts: string[] = []
  for (const k of HEADLINE_KEYS) {
    const v = (entry as any)[k]
    if (v === undefined || v === null) continue
    if (k === "jigPath" && typeof v === "string") {
      parts.push(`jig=${basename(v).replace(/\.ts$/, "")}`)
    } else {
      parts.push(`${k}=${shortValue(v)}`)
    }
  }
  const errVal = (entry as any).error
  let level: LogLevel = "info"
  if (errVal !== undefined && errVal !== null) {
    level = "error"
    const errMsg =
      errVal instanceof Error
        ? errVal.message
        : typeof errVal === "string"
          ? errVal
          : ((errVal as any)?.message ?? shortValue(errVal))
    parts.push(`error=${shortValue(errMsg)}`)
  } else if (/error|failed|not-ready/i.test(event)) {
    level = "warn"
  }
  const msg = `[${source}] ${event}${parts.length ? " " + parts.join(" ") : ""}`
  return { msg, level }
}

// The system prompt (SKILL.md + tool catalog + schemas for authoring) is static
// within a session but gets re-logged inside the full `messages` array on every
// round. Elide system-role message content to a short placeholder so the logs
// don't carry N copies of it — the full prompt is still captured once at
// session-start via the separate `systemPrompt` field. Non-mutating: callers
// log the live `session.messages`, so we copy rather than edit in place.
const ELIDE_MIN_LEN = 200

function looksLikeMessages(v: unknown): v is Array<Record<string, unknown>> {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((m) => m != null && typeof m === "object" && "role" in (m as object) && "content" in (m as object))
  )
}

function leanEntry(entry: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(entry)) {
    if (looksLikeMessages(v)) {
      out[k] = v.map((m) =>
        m.role === "system" && typeof m.content === "string" && m.content.length > ELIDE_MIN_LEN
          ? { ...m, content: `[system prompt elided: ${m.content.length} chars]` }
          : m,
      )
    } else {
      out[k] = v
    }
  }
  return out
}

function stringifyPayload(entry: unknown): string | null {
  try {
    const s = JSON.stringify(entry)
    if (s.length <= MAX_PAYLOAD_BYTES) return s
    return s.slice(0, MAX_PAYLOAD_BYTES) + `…[+${s.length - MAX_PAYLOAD_BYTES} bytes truncated]`
  } catch {
    return null
  }
}

export function logSessionEvent(entry: Record<string, unknown>): void {
  // Drop repeated system-prompt copies out of logged `messages` arrays, then
  // REDACT ONCE and reuse for both sinks. The log file previously received the
  // raw object, so bearer tokens / api keys landed in jig.log (the persistent
  // /data volume in service mode) in cleartext even though the SQLite mirror
  // was redacted. Redact before the file write too so neither sink leaks.
  const lean = leanEntry(entry)
  let redacted: Record<string, unknown>
  try {
    redacted = redact(lean) as Record<string, unknown>
  } catch {
    // Redaction failed — never fall back to the raw object (that's the leak we
    // are closing). Emit a minimal breadcrumb instead.
    redacted = {
      source: entry.source ?? entry.type ?? "session",
      event: entry.event ?? "?",
      note: "[redaction failed — payload omitted]",
    }
  }

  queue.push(
    stringifyLine({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...redacted,
    }) + "\n"
  )

  if (!flushPending) {
    flushPending = true
    queueMicrotask(flush)
  }

  // Mirror into SQLite for the dashboard Logs view (same redacted payload).
  // Wrapped so a logging failure can't break the caller.
  try {
    const { msg, level } = deriveHeadline(redacted)
    recordStructured(level, msg, stringifyPayload(redacted))
  } catch {}
}

export async function resetSessionLog(): Promise<void> {
  queue = []
  flushPending = false
  try {
    await mkdir(dirname(SESSION_LOG_PATH), { recursive: true })
    await appendFile(
      SESSION_LOG_PATH,
      stringifyLine({
        ts: new Date().toISOString(),
        pid: process.pid,
        source: "session-log",
        event: "start",
        path: SESSION_LOG_PATH,
      }) + "\n"
    )
  } catch {}
}

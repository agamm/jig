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
  queue.push(
    stringifyLine({
      ts: new Date().toISOString(),
      pid: process.pid,
      ...entry,
    }) + "\n"
  )

  if (!flushPending) {
    flushPending = true
    queueMicrotask(flush)
  }

  // Mirror into SQLite for the dashboard Logs view. Redact first so secrets
  // never reach the row. Wrapped so a logging failure can't break the caller.
  try {
    const redacted = redact(entry) as Record<string, unknown>
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

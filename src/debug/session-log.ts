import { appendFile, mkdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { DATA_DIR } from "../config/paths.js"

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

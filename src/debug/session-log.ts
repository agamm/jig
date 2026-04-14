import { appendFile, writeFile } from "node:fs/promises"

export const SESSION_LOG_PATH = "/tmp/jig.log"

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
    await writeFile(SESSION_LOG_PATH, "")
  } catch {}
}

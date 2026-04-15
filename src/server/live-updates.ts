import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs"
import { JIGS_DIR } from "../config/paths.js"
import { invalidateJigsCache } from "../discover.js"

type LiveUpdateEvent = "jigs" | "ready" | "ping"

type Subscriber = {
  close: () => void
  enqueue: (chunk: Uint8Array) => void
  heartbeat: ReturnType<typeof setInterval>
}

const encoder = new TextEncoder()
const subscribers = new Set<Subscriber>()
const HEARTBEAT_MS = 15_000
const JIG_EVENT_DEBOUNCE_MS = 120

let jigWatch: FSWatcher | null = null
let watchersStarted = false
let pendingJigBroadcast: ReturnType<typeof setTimeout> | null = null

function encodeEvent(event: LiveUpdateEvent, payload?: Record<string, unknown>): Uint8Array {
  const lines = [`event: ${event}`]
  if (payload) lines.push(`data: ${JSON.stringify(payload)}`)
  return encoder.encode(`${lines.join("\n")}\n\n`)
}

function removeSubscriber(subscriber: Subscriber): void {
  clearInterval(subscriber.heartbeat)
  subscribers.delete(subscriber)
  try {
    subscriber.close()
  } catch {}
}

function emit(event: LiveUpdateEvent, payload?: Record<string, unknown>): void {
  const chunk = encodeEvent(event, payload)
  for (const subscriber of [...subscribers]) {
    try {
      subscriber.enqueue(chunk)
    } catch {
      removeSubscriber(subscriber)
    }
  }
}

export function broadcastJigsUpdated(source: string = "backend"): void {
  if (pendingJigBroadcast) return
  pendingJigBroadcast = setTimeout(() => {
    pendingJigBroadcast = null
    emit("jigs", { at: Date.now(), source })
  }, JIG_EVENT_DEBOUNCE_MS)
}

export function createLiveUpdatesResponse(): Response {
  let subscriber: Subscriber | null = null

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      subscriber = {
        enqueue: (chunk) => controller.enqueue(chunk),
        close: () => controller.close(),
        heartbeat: setInterval(() => {
          try {
            controller.enqueue(encodeEvent("ping", { at: Date.now() }))
          } catch {
            if (subscriber) removeSubscriber(subscriber)
          }
        }, HEARTBEAT_MS),
      }

      subscribers.add(subscriber)
      controller.enqueue(encodeEvent("ready", { at: Date.now() }))
    },
    cancel() {
      if (!subscriber) return
      removeSubscriber(subscriber)
      subscriber = null
    },
  })

  return new Response(stream, {
    headers: {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
      "X-Accel-Buffering": "no",
    },
  })
}

export function startLiveUpdateWatchers(): void {
  if (watchersStarted) return
  watchersStarted = true

  if (!existsSync(JIGS_DIR)) {
    mkdirSync(JIGS_DIR, { recursive: true })
  }

  try {
    jigWatch = watch(JIGS_DIR, { persistent: false }, (_eventType, filename) => {
      if (typeof filename === "string" && (filename === "drafts" || filename.startsWith("drafts/"))) {
        return
      }
      invalidateJigsCache()
      broadcastJigsUpdated("filesystem")
    })
  } catch (error) {
    console.warn("[live-updates] failed to watch jigs directory:", (error as Error)?.message ?? String(error))
  }
}

/**
 * Durable scheduler — SQLite-backed cron scheduler embedded in `jig start`.
 *
 * Survives process crashes, catches up missed runs on restart,
 * exposes webhook endpoints. Uses croner for cron math.
 */
import { syncSchedules } from "./sync.js"
import { tick } from "./tick.js"
import { recoverMissedRuns } from "./recover.js"
import { isServiceMode } from "../config/runtime.js"
import { isPasswordSet, isUnlocked } from "../crypto/password.js"

const TICK_INTERVAL_MS = 60_000

export function millisecondsUntilNextSchedulerTick(nowMs: number = Date.now()): number {
  const remainder = nowMs % TICK_INTERVAL_MS
  return remainder === 0 ? TICK_INTERVAL_MS : TICK_INTERVAL_MS - remainder
}

export async function startScheduler(): Promise<{ stop: () => void }> {
  // Initial sync — reconcile jig trigger configs with schedules table
  await syncSchedules()

  // Recover from crash — mark interrupted runs, handle missed schedules
  recoverMissedRuns()

  let tickInFlight = false
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const runLoop = async () => {
    if (tickInFlight) return
    // In service mode, pause ticks until the user has unlocked the instance.
    // Credentials are encrypted and inaccessible until then, so a tick that
    // fires a jig would only crash on first credential access.
    if (isServiceMode() && isPasswordSet() && !isUnlocked()) return
    tickInFlight = true
    try {
      await syncSchedules()
      tick()
    } catch (e: any) {
      console.error("[scheduler] tick error:", e?.message ?? e)
    } finally {
      tickInFlight = false
    }
  }

  const scheduleNextTick = () => {
    if (stopped) return
    const delay = millisecondsUntilNextSchedulerTick()
    timer = setTimeout(() => {
      timer = null
      void runLoop().finally(() => {
        scheduleNextTick()
      })
    }, delay)
  }

  // Align ticks to the top of the next minute instead of 60s from process start.
  scheduleNextTick()

  console.log("[scheduler] started (minute-aligned tick)")
  return {
    stop: () => {
      stopped = true
      if (timer) clearTimeout(timer)
    },
  }
}

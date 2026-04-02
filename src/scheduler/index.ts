/**
 * Durable scheduler — SQLite-backed cron scheduler embedded in `jig start`.
 *
 * Survives process crashes, catches up missed runs on restart,
 * exposes webhook endpoints. Uses croner for cron math.
 */
import { syncSchedules } from "./sync.js"
import { tick } from "./tick.js"
import { recoverMissedRuns } from "./recover.js"

const TICK_INTERVAL_MS = 60_000

export async function startScheduler(): Promise<{ stop: () => void }> {
  // Initial sync — reconcile jig trigger configs with schedules table
  await syncSchedules()

  // Recover from crash — mark interrupted runs, handle missed schedules
  recoverMissedRuns()

  let tickInFlight = false
  const runLoop = async () => {
    if (tickInFlight) return
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

  // Tick loop — re-sync triggers and fire due cron runs every 60s
  const timer = setInterval(() => { void runLoop() }, TICK_INTERVAL_MS)

  console.log("[scheduler] started (60s tick interval)")
  return { stop: () => clearInterval(timer) }
}

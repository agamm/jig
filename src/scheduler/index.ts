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
import { pruneOldRuns } from "../db.js"
import { gcRuntimeCache } from "../services/jig-runtime.js"
import { sweepOrphanedDraftJigs } from "../services/jig-store.js"
import type { SchedulerHealth } from "../../shared/api.js"

const TICK_INTERVAL_MS = 60_000

const RUN_RETENTION_DAYS = (() => {
  const raw = Number(process.env.JIG_RUN_RETENTION_DAYS)
  return Number.isFinite(raw) && raw > 0 ? raw : 30
})()

export function millisecondsUntilNextSchedulerTick(nowMs: number = Date.now()): number {
  const remainder = nowMs % TICK_INTERVAL_MS
  return remainder === 0 ? TICK_INTERVAL_MS : TICK_INTERVAL_MS - remainder
}

// ---------------------------------------------------------------------------
// Health — lets /api/health answer "is the scheduler actually ticking?"
// ---------------------------------------------------------------------------

let schedulerRunning = false
let lastTickAt: number | null = null

export function getSchedulerHealth(): SchedulerHealth {
  return {
    running: schedulerRunning,
    lastTickAt: lastTickAt ? new Date(lastTickAt).toISOString() : null,
  }
}

// ---------------------------------------------------------------------------
// Locked-too-long alert
//
// A restart re-locks the instance and every cron schedule silently stops. The
// tick loop still runs (it just returns early), so this is the one place that
// can notice. Sending needs the AgentMail key, which is encrypted — hence the
// on-volume copy in services/agentmail.ts.
//
// Only covers a live process. A container that never boots sends nothing;
// that case needs an external check on /api/health.
// ---------------------------------------------------------------------------

const LOCKED_ALERT_AFTER_MS = (() => {
  const raw = Number(process.env.JIG_LOCKED_ALERT_MINUTES)
  return (Number.isFinite(raw) && raw > 0 ? raw : 60) * 60_000
})()

let lockedSinceMs: number | null = null
let lockedAlertSent = false

async function maybeAlertStillLocked(): Promise<void> {
  if (lockedSinceMs === null) lockedSinceMs = Date.now()
  if (lockedAlertSent) return
  if (Date.now() - lockedSinceMs < LOCKED_ALERT_AFTER_MS) return
  lockedAlertSent = true

  const minutes = Math.round((Date.now() - lockedSinceMs) / 60_000)
  try {
    const { listEnabledCronSchedules } = await import("../db.js")
    const paused = listEnabledCronSchedules().map((s) => s.jig_id)
    const { notifySystem } = await import("../services/system-notify.js")
    const sent = await notifySystem({
      source: "scheduler.locked",
      title: "jig is locked — scheduled jigs are paused",
      body:
        `jig has been locked for ${minutes} minutes, since it last restarted.\n\n` +
        `Credentials stay encrypted until you unlock, so the scheduler is paused and ` +
        `nothing has run in that time.\n\n` +
        (paused.length
          ? `Paused schedules (${paused.length}): ${paused.join(", ")}\n\n`
          : "") +
        `Unlock it:\n  jig unlock\n\nOr open the dashboard and enter your password.`,
    })
    if (!sent) {
      console.warn(
        "[scheduler] locked for " + minutes + "m and the lock alert could not be sent " +
        "(no cached AgentMail key — it is written on unlock)",
      )
    }
  } catch (e: any) {
    console.error("[scheduler] locked-alert failed:", e?.message ?? e)
  }
}

// ---------------------------------------------------------------------------
// Daily maintenance — retention pruning, runtime-cache sweep
// ---------------------------------------------------------------------------

let lastMaintenanceDay: string | null = null

function maybeRunDailyMaintenance(): void {
  const today = new Date().toISOString().slice(0, 10)
  if (lastMaintenanceDay === today) return
  lastMaintenanceDay = today
  try {
    const pruned = pruneOldRuns(RUN_RETENTION_DAYS)
    const swept = gcRuntimeCache()
    const orphanedDrafts = sweepOrphanedDraftJigs()
    if (pruned.runs > 0 || swept.removed > 0 || orphanedDrafts.length > 0) {
      console.log(
        `[scheduler] maintenance: pruned ${pruned.runs} runs / ${pruned.steps} steps older than ${RUN_RETENTION_DAYS}d, ` +
        `swept ${swept.removed} stale runtime files, ` +
        `removed ${orphanedDrafts.length} orphaned draft jigs${orphanedDrafts.length ? ` (${orphanedDrafts.join(", ")})` : ""}`,
      )
    }
  } catch (e: any) {
    console.error("[scheduler] maintenance failed:", e?.message ?? e)
  }
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
    // The loop being alive is what health reports — record it even when the
    // locked gate below skips the actual tick work.
    lastTickAt = Date.now()
    // In service mode, pause ticks until the user has unlocked the instance.
    // Credentials are encrypted and inaccessible until then, so a tick that
    // fires a jig would only crash on first credential access.
    if (isServiceMode() && isPasswordSet() && !isUnlocked()) {
      await maybeAlertStillLocked()
      return
    }
    lockedSinceMs = null
    lockedAlertSent = false
    tickInFlight = true
    try {
      await syncSchedules()
      tick()
      maybeRunDailyMaintenance()
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

  schedulerRunning = true
  console.log("[scheduler] started (minute-aligned tick)")
  return {
    stop: () => {
      stopped = true
      schedulerRunning = false
      if (timer) clearTimeout(timer)
    },
  }
}

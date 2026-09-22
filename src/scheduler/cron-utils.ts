import { Cron } from "croner"
import { schedulerTimeZone } from "../config/timezone.js"

export function computeNextRun(cronExpr: string, timezone = schedulerTimeZone()): number | null {
  try {
    const job = new Cron(cronExpr, { timezone })
    const next = job.nextRun()
    return next ? Math.floor(next.getTime() / 1000) : null
  } catch (error) {
    // The caller reports this as "Invalid cron expression", which is only one of the
    // possible causes here (croner can also throw on a bad timezone or an internal
    // error): log the real one so a wrong report doesn't send someone to fix the
    // wrong thing.
    console.error(`[scheduler] cron parse failed for "${cronExpr}" (tz=${timezone}):`, (error as Error)?.message ?? error)
    return null
  }
}

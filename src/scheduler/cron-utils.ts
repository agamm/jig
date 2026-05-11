import { Cron } from "croner"
import { schedulerTimeZone } from "../config/timezone.js"

export function computeNextRun(cronExpr: string, timezone = schedulerTimeZone()): number | null {
  try {
    const job = new Cron(cronExpr, { timezone })
    const next = job.nextRun()
    return next ? Math.floor(next.getTime() / 1000) : null
  } catch {
    return null
  }
}

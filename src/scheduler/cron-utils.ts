import { Cron } from "croner"

export function computeNextRun(cronExpr: string): number | null {
  try {
    const job = new Cron(cronExpr)
    const next = job.nextRun()
    return next ? Math.floor(next.getTime() / 1000) : null
  } catch {
    return null
  }
}

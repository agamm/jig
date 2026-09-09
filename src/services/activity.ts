/**
 * Runs and model spend per day, for the chart at the top of the jigs page.
 * Read from the runs table alone: status per run and the cost OpenRouter
 * reported for its model calls (runs.cost_usd). Days follow the instance's
 * scheduler timezone, so "today" on the chart is the owner's today.
 */
import type { ActivityDay, ActivityReport } from "../../shared/api.js"
import { listFinishedRunsSince } from "../db.js"
import { schedulerTimeZone } from "../config/timezone.js"
import { RUN_RETENTION_DAYS } from "../scheduler/index.js"

const DAY_MS = 24 * 60 * 60 * 1000

export function buildActivity(opts: { since: Date; now?: Date; timeZone?: string }): ActivityReport {
  const now = opts.now ?? new Date()
  const timeZone = opts.timeZone ?? schedulerTimeZone()
  const windowMs = Math.max(DAY_MS, now.getTime() - opts.since.getTime())
  const previousSince = new Date(opts.since.getTime() - windowMs)
  const dayOf = dayKeyFormatter(timeZone)

  const byDay = new Map<string, ActivityDay>()
  for (let t = opts.since.getTime(); t <= now.getTime(); t += DAY_MS) {
    const key = dayOf(new Date(t))
    if (!byDay.has(key)) byDay.set(key, { date: key, ok: 0, fail: 0, costUsd: 0, byJig: [] })
  }
  const todayKey = dayOf(now)
  if (!byDay.has(todayKey)) byDay.set(todayKey, { date: todayKey, ok: 0, fail: 0, costUsd: 0, byJig: [] })

  const totals = { runs: 0, ok: 0, fail: 0, costUsd: 0, costKnown: false }
  const previous = { runs: 0, costUsd: 0 }
  for (const run of listFinishedRunsSince(previousSince)) {
    const startedMs = sqliteToMs(run.started_at)
    const cost = typeof run.cost_usd === "number" ? run.cost_usd : 0
    if (startedMs < opts.since.getTime()) {
      previous.runs++
      previous.costUsd += cost
      continue
    }
    const day = byDay.get(dayOf(new Date(startedMs)))
    if (!day) continue
    const ok = run.status === "success"
    day[ok ? "ok" : "fail"]++
    day.costUsd += cost
    let jig = day.byJig.find((j) => j.jigId === run.jig_id)
    if (!jig) {
      jig = { jigId: run.jig_id, ok: 0, fail: 0, costUsd: 0 }
      day.byJig.push(jig)
    }
    jig[ok ? "ok" : "fail"]++
    jig.costUsd += cost
    totals.runs++
    totals[ok ? "ok" : "fail"]++
    totals.costUsd += cost
    if (typeof run.cost_usd === "number") totals.costKnown = true
  }

  const days = [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
  for (const day of days) day.byJig.sort((a, b) => b.costUsd - a.costUsd || b.ok + b.fail - (a.ok + a.fail))
  // Runs are pruned after RUN_RETENTION_DAYS, so a previous window that starts
  // before that cut-off is partly missing and would make every delta a lie.
  const previousKept = previousSince.getTime() >= now.getTime() - RUN_RETENTION_DAYS * DAY_MS
  return { generatedAt: now.toISOString(), since: opts.since.toISOString(), timeZone, days, totals, previous: previousKept ? previous : null }
}

/** YYYY-MM-DD in a timezone; en-CA is the locale whose short date is already ISO-shaped. */
function dayKeyFormatter(timeZone: string): (d: Date) => string {
  let fmt: Intl.DateTimeFormat
  try {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
  } catch {
    fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "UTC", year: "numeric", month: "2-digit", day: "2-digit" })
  }
  return (d) => fmt.format(d)
}

/** datetime('now') writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. */
function sqliteToMs(value: string): number {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

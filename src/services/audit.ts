/**
 * Audit report: the read a coding agent heals from.
 *
 * Built only from what already exists: runs and run_steps, the jigs and
 * jig_versions tables, the schedules table, and the durable settings rows that
 * failure alerting (failure_incident.<jig>) and the MCP client
 * (connection_status.<server>) already keep. No new tables, and never the
 * capped logs table. The streak and the incident come from the same functions
 * repair and alerting use, so the three cannot disagree about what is failing.
 */
import packageJson from "../../package.json"
import type { AuditConnection, AuditFailingStep, AuditJig, AuditReport, AuditRun } from "../../shared/api.js"
import { isServiceMode } from "../config/runtime.js"
import { getJigRuns, listAllSchedules, type RunRow, type ScheduleRow, type StepRow } from "../db.js"
import { extractConnections } from "../domain/jig-source.js"
import { loadServerConfigs } from "../mcp/config.js"
import { getSchedulerHealth } from "../scheduler/index.js"
import { getConnectionStatus } from "./connection-status.js"
import { getActiveCode, getVersion, listJigs } from "./jig-store.js"
import { readFailureIncident } from "./run-failure-notify.js"
import { repairInstructionPrefix, summarizeFailureStreak } from "./run-repair.js"
import { hasActiveRunForJig } from "./run-store.js"

const DEFAULT_RUNS_PER_JIG = 10
const DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000
// Ticks are minute-aligned, so a due time more than two minutes old was missed.
const OVERDUE_GRACE_S = 120

type RunWithSteps = RunRow & { steps: StepRow[] }

export async function buildAuditReport(opts: {
  since: Date
  jigId?: string
  runsPerJig?: number
}): Promise<AuditReport> {
  const runsPerJig = opts.runsPerJig ?? DEFAULT_RUNS_PER_JIG
  const now = Date.now()

  const jigs = listJigs().filter((j) => j.activeVersionId != null && (!opts.jigId || j.id === opts.jigId))
  const schedules = new Map(listAllSchedules().map((s) => [s.jig_id, s]))
  const unhealthy = await listUnhealthyConnections()
  const unhealthyNames = new Set(unhealthy.map((c) => c.name))

  const entries = jigs.map((jig) =>
    auditJig(jig.id, jig.name, jig.pendingVersionId, schedules.get(jig.id) ?? null, runsPerJig, opts.since, unhealthyNames),
  )
  entries.sort((a, b) => b.consecutiveFailures - a.consecutiveFailures || a.id.localeCompare(b.id))

  // The schedule lists follow the jig filter: asking about one jig should not
  // surface every other jig's schedule state.
  const rows = opts.jigId
    ? [schedules.get(opts.jigId)].filter((r): r is ScheduleRow => !!r)
    : [...schedules.values()]

  return {
    generatedAt: new Date(now).toISOString(),
    since: opts.since.toISOString(),
    instance: {
      version: packageJson.version,
      mode: isServiceMode() ? "service" : "local",
      scheduler: getSchedulerHealth(),
    },
    connections: unhealthy,
    scheduler: {
      problems: rows.filter((r) => r.error).map((r) => ({ jigId: r.jig_id, error: r.error! })),
      disabled: rows.filter((r) => r.enabled !== 1).map((r) => r.jig_id),
      // Snapshot heuristic: an enabled cron whose due time is well in the past
      // was missed (scheduler stopped, instance locked, or a tick that keeps
      // throwing). A row read mid-tick can be seconds late and mean nothing.
      overdue: rows
        .filter((r) => r.trigger_type === "cron" && r.enabled === 1 && r.next_run_at != null
          && r.next_run_at < now / 1000 - OVERDUE_GRACE_S)
        .map((r) => ({ jigId: r.jig_id, nextRunAt: unixToIso(r.next_run_at)! })),
    },
    jigs: entries,
    truncated: { runsPerJig },
  }
}

/** "30m", "6h", "7d", "90s" or an ISO timestamp; 24h back when absent. Throws on anything else. */
export function parseSince(input?: string, now: number = Date.now()): Date {
  if (!input) return new Date(now - DEFAULT_SINCE_MS)
  const rel = /^(\d+)([smhd])$/.exec(input.trim())
  if (rel) {
    const unit = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[rel[2] as "s" | "m" | "h" | "d"]
    return new Date(now - Number(rel[1]) * unit)
  }
  const abs = Date.parse(input)
  if (Number.isFinite(abs)) return new Date(abs)
  throw new Error(`Invalid since "${input}": use an ISO timestamp or a window like 30m, 6h, 7d`)
}

// ---------------------------------------------------------------------------
// Per jig
// ---------------------------------------------------------------------------

function auditJig(
  id: string,
  name: string,
  pendingVersionId: number | null,
  schedule: ScheduleRow | null,
  runsPerJig: number,
  since: Date,
  unhealthyNames: Set<string>,
): AuditJig {
  const runs = getJigRuns(id, runsPerJig)
  const finished = runs.filter((r) => r.status !== "running")
  const streak = summarizeFailureStreak(runs)
  const incident = readFailureIncident(id)
  const failing = streak.streak > 0
  const latest = finished[0]
  const oldestInStreak = finished[streak.streak - 1]

  const connections = extractConnections(getActiveCode(id) ?? "")
  const pending = pendingVersionId != null ? getVersion(pendingVersionId) : null

  return {
    id,
    name,
    trigger: schedule?.trigger_type ?? "manual",
    cronExpr: schedule?.cron_expr ?? null,
    timezone: schedule?.timezone ?? null,
    enabled: schedule ? schedule.enabled === 1 : true,
    nextRunAt: unixToIso(schedule?.next_run_at),
    lastRunAt: unixToIso(schedule?.last_run_at),
    scheduleError: schedule?.error ?? null,
    running: hasActiveRunForJig(id),
    // The runs window decides whether it is failing now; the incident row
    // remembers what that window may already have scrolled past.
    consecutiveFailures: failing ? Math.max(streak.streak, incident?.failCount ?? 0) : 0,
    failingSince: failing ? earliestIso(incident?.firstFailedAt, sqliteToMs(oldestInStreak.started_at)) : null,
    lastFailureAt: failing ? sqliteToIso(latest.finished_at ?? latest.started_at) : null,
    alertsSent: incident?.emailsSent ?? 0,
    lastFailure: failing
      ? { runId: latest.id, at: sqliteToIso(latest.started_at), error: streak.error, step: failingStepOf(latest) }
      : null,
    runs: runs.filter((r) => sqliteToMs(r.started_at) >= since.getTime()).map(auditRun),
    pending: pending
      ? {
          versionId: pending.id,
          author: pending.author,
          message: pending.message,
          createdAt: new Date(pending.createdAt).toISOString(),
          // The session prompt is the rendered conversation, so the repair
          // instruction sits after a "User:" prefix rather than at offset 0.
          likelyRepair: pending.author === "agent" && (pending.prompt ?? "").includes(repairInstructionPrefix(id)),
        }
      : null,
    connections,
    unhealthyConnections: connections.filter((c) => unhealthyNames.has(c)),
  }
}

function auditRun(run: RunWithSteps): AuditRun {
  return {
    id: run.id,
    startedAt: sqliteToIso(run.started_at),
    finishedAt: run.finished_at ? sqliteToIso(run.finished_at) : null,
    durationMs: run.duration_ms,
    status: run.status,
    error: run.error,
    failingStep: failingStepOf(run),
    steps: run.steps.map((s) => ({ seq: s.seq, label: s.label, status: s.status, durationMs: s.duration_ms })),
  }
}

function failingStepOf(run: RunWithSteps): AuditFailingStep | null {
  const step = run.steps.find((s) => s.status === "fail")
  if (!step) return null
  let connections: string[] = []
  try { connections = step.connections ? JSON.parse(step.connections) : [] } catch {}
  return { seq: step.seq, label: step.label, error: step.error, connections }
}

async function listUnhealthyConnections(): Promise<AuditConnection[]> {
  const out: AuditConnection[] = []
  for (const name of Object.keys(await loadServerConfigs())) {
    const status = getConnectionStatus(name)
    if (status && status.state !== "ok") {
      out.push({ name, state: status.state, detail: status.detail ?? null, at: status.at })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// Time helpers: runs use SQLite datetime('now'), schedules unix seconds,
// incidents and versions Date.now() ms. The report speaks ISO throughout.
// ---------------------------------------------------------------------------

function sqliteToMs(value: string): number {
  // datetime('now') writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker.
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? ms : 0
}

function sqliteToIso(value: string): string {
  const ms = sqliteToMs(value)
  return ms ? new Date(ms).toISOString() : value
}

function unixToIso(seconds: number | null | undefined): string | null {
  return seconds ? new Date(seconds * 1000).toISOString() : null
}

function earliestIso(...candidates: (number | undefined)[]): string {
  const known = candidates.filter((c): c is number => typeof c === "number" && c > 0)
  return new Date(Math.min(...known)).toISOString()
}

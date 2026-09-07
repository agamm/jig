/**
 * The failure log: every failed run in a window, classified with a remedy.
 *
 * Derived at read time from runs and run_steps, so it cannot drift from what
 * the dashboard shows, and it goes back as far as run retention does. This is
 * what a coding agent reads before touching a jig (`jig debug failures`) and
 * what the audit and the failure email quote a verdict from.
 */
import type { FailureEntry, FailureLog } from "../../shared/api.js"
import { listFailedRunsSince, type RunRow, type StepRow } from "../db.js"
import { extractConnections } from "../domain/jig-source.js"
import { isCancellationMessage } from "../run-cancel.js"
import { classifyFailure, type FailureVerdict } from "./failure-class.js"
import { getActiveCode } from "./jig-store.js"

const DEFAULT_LIMIT = 200

export function buildFailureLog(opts: { since: Date; jigId?: string; limit?: number }): FailureLog {
  const limit = opts.limit ?? DEFAULT_LIMIT
  // One extra row tells us whether the window was cut.
  const rows = listFailedRunsSince(opts.since, limit + 1, opts.jigId)
  const jigConnections = new Map<string, string[]>()
  const failures = rows
    .slice(0, limit)
    .filter((run) => !isCancellationMessage(run.error) && !isCancellationMessage(run.output))
    .map((run) => {
      if (!jigConnections.has(run.jig_id)) jigConnections.set(run.jig_id, extractConnections(getActiveCode(run.jig_id) ?? ""))
      return failureEntry(run, jigConnections.get(run.jig_id)!)
    })
  return {
    generatedAt: new Date().toISOString(),
    since: opts.since.toISOString(),
    failures,
    truncated: rows.length > limit,
  }
}

/** The verdict for one run, looking up the jig's connections; for callers that hold a run and nothing else. */
export function verdictForRun(run: RunRow & { steps: StepRow[] }): FailureVerdict {
  const { cause, remedy } = failureEntry(run, extractConnections(getActiveCode(run.jig_id) ?? ""))
  return { cause, remedy }
}

export function failureEntry(run: RunRow & { steps: StepRow[] }, jigConnections: string[]): FailureEntry {
  const step = run.steps.find((s) => s.status === "fail") ?? null
  let stepConnections: string[] = []
  try { stepConnections = step?.connections ? JSON.parse(step.connections) : [] } catch {}
  const error = (step?.error || run.error || "(no error message)").trim()
  const connections = stepConnections.length ? stepConnections : jigConnections
  return {
    runId: run.id,
    jigId: run.jig_id,
    at: sqliteToIso(run.started_at),
    step: step ? { seq: step.seq, label: step.label } : null,
    error,
    ...classifyFailure(error, { jigId: run.jig_id, connections }),
    connections,
  }
}

/** datetime('now') writes "YYYY-MM-DD HH:MM:SS" in UTC with no zone marker. */
function sqliteToIso(value: string): string {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(" ", "T")}Z` : value
  const ms = Date.parse(iso)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : value
}

/**
 * The one path that turns a jig id into a running jig.
 *
 * Two callers drive runs — the HTTP handler (run-api.ts) and the scheduler /
 * webhook trigger (background-run.ts). They may differ only in policy: how a
 * failure is reported (HTTP status vs schedule error row), whether they await
 * completion, and what they log. Everything between — materializing the active
 * version, the connection preflight, tracked-run bookkeeping, event
 * persistence, skipped-run cleanup, failure notification — belongs here, so the
 * two entry points cannot drift apart.
 */
import { completeRun, openDb } from "../db.js"
import { runJig, persist } from "../runner.js"
import { applyRunEvent, discardTrackedRun, finishTrackedRun, getSignalForRun } from "./run-store.js"
import { maybeNotifyRunFailure } from "./run-failure-notify.js"
import { missingConnectionsForJig } from "./connection-preflight.js"
import { materializeActiveVersion } from "./jig-runtime.js"
import { getJigRow, type JigRow } from "./jig-store.js"

export type PreparedRun =
  | { ok: true; jigPath: string; jigRow: JigRow }
  | { ok: false; reason: "not-found" }
  | { ok: false; reason: "no-active-version" }
  | { ok: false; reason: "missing-connections"; missing: string[]; message: string }

export function missingConnectionsMessage(missing: string[]): string {
  return missing.length === 1
    ? `Connection required: ${missing[0]}`
    : `Connections required: ${missing.join(", ")}`
}

/**
 * Resolve a jig to a runnable file and check its connections are set up.
 * Returns a discriminated result rather than throwing, so each caller can map
 * the failure onto its own reporting channel.
 */
export async function prepareRun(jigId: string): Promise<PreparedRun> {
  const jigRow = getJigRow(jigId)
  if (!jigRow) return { ok: false, reason: "not-found" }

  const materialized = await materializeActiveVersion(jigId)
  if (!materialized) return { ok: false, reason: "no-active-version" }

  const missing = missingConnectionsForJig(materialized.path)
  if (missing.length > 0) {
    return { ok: false, reason: "missing-connections", missing, message: missingConnectionsMessage(missing) }
  }

  return { ok: true, jigPath: materialized.path, jigRow }
}

export interface ExecuteRunOptions {
  jigId: string
  /** Row id from insertRun, or a negative sentinel for a dry run. */
  runId: number
  jigPath: string
  params?: Record<string, unknown>
  dryRun?: boolean
  /** Log tag for mirrored step/error lines — "run" or "scheduler". */
  logPrefix: string
  modelOverride?: string | null
  stepModelOverrides?: Record<string, string>
  toolTimeoutMs?: number | null
}

/**
 * Run the jig to completion. Owns the tracked-run lifecycle: on a skipped run
 * the run row is deleted and the tracked run discarded (it never happened); on
 * any other outcome the tracked run is finished and failure notification is
 * queued. The caller must have already called startTrackedRun.
 */
export async function executeRun(options: ExecuteRunOptions): Promise<{ skipped: boolean }> {
  const { jigId, runId, jigPath, logPrefix, dryRun = false } = options
  const startTime = Date.now()
  const persistHandler = dryRun ? null : persist(runId, startTime)
  let skipped = false

  try {
    const result = await runJig(jigPath, options.params ?? {}, (event) => {
      // "skipped" is not a persistable outcome — the run row is removed below.
      if (event.type !== "skipped") {
        applyRunEvent(runId, event)
        persistHandler?.(event)
      }
      // Mirror step failures + fatal errors to console.error so the Logs page
      // surfaces *why* a run failed (silent:true otherwise hides it).
      if (event.type === "step-done" && event.status === "fail") {
        console.error(`[${logPrefix}] ${jigId} step ${event.seq} failed: ${event.error ?? "(no error message)"}`)
      } else if (event.type === "error") {
        console.error(`[${logPrefix}] ${jigId} error: ${event.message}`)
      } else if (event.type === "done") {
        console.log(`[${logPrefix}] ${jigId} done in ${event.durationMs}ms`)
      }
    }, {
      dryRun,
      silent: true,
      signal: getSignalForRun(runId),
      modelOverride: options.modelOverride ?? null,
      stepModelOverrides: options.stepModelOverrides ?? {},
      toolTimeoutMs: options.toolTimeoutMs ?? null,
      jigId,
    })

    if (result.skipped && !dryRun) {
      skipped = true
      const db = openDb()
      db.prepare(`DELETE FROM run_steps WHERE run_id = ?`).run(runId)
      db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId)
    }
    return { skipped }
  } catch (e: any) {
    if (!dryRun) completeRun(runId, "fail", Date.now() - startTime, e?.message ?? String(e))
    throw e
  } finally {
    if (skipped) discardTrackedRun(runId)
    else {
      finishTrackedRun(runId)
      void maybeNotifyRunFailure(jigId, runId, dryRun).catch(() => {})
    }
  }
}

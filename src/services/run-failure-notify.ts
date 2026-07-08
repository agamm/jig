import { getRun } from "../db.js"
import { isCancellationMessage } from "../run-cancel.js"
import { formatFailureBody, notify } from "./notify.js"
import { maybeStartAutoRepair } from "./run-repair.js"

export async function maybeNotifyRunFailure(
  jigId: string,
  runId: number,
  dryRun: boolean,
  deps: {
    getRun?: typeof getRun
    notify?: typeof notify
    startAutoRepair?: typeof maybeStartAutoRepair
  } = {}
): Promise<boolean> {
  if (dryRun || runId <= 0) return false

  const run = (deps.getRun ?? getRun)(runId)
  if (!run || run.status !== "fail") return false
  if (isCancellationMessage(run.error) || isCancellationMessage(run.output)) return false

  await (deps.notify ?? notify)({
    title: `Jig "${jigId}" failed`,
    body: formatFailureBody({
      jigId,
      error: run.error,
      startedAt: run.started_at,
      durationMs: run.duration_ms,
    }),
    kind: "fail",
    jigId,
    runId,
  })

  // Same chokepoint covers auto-repair: every real failure is a candidate,
  // and the guards in run-repair.ts decide whether this one warrants a fix.
  void (deps.startAutoRepair ?? maybeStartAutoRepair)(jigId, runId).catch(() => {})

  return true
}

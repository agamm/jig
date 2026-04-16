import { getRun } from "../db.js"
import { isCancellationMessage } from "../run-cancel.js"
import { formatFailureBody, notify } from "./notify.js"

export async function maybeNotifyRunFailure(
  jigId: string,
  runId: number,
  dryRun: boolean,
  deps: {
    getRun?: typeof getRun
    notify?: typeof notify
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

  return true
}

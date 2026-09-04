import { getRun, getSetting, setSetting } from "../db.js"
import { isCancellationMessage } from "../run-cancel.js"
import { publicUrl } from "../config/runtime.js"
import { formatFailureBody, notify } from "./notify.js"
import { maybeStartAutoRepair, summarizeFailureStreak } from "./run-repair.js"

// ---------------------------------------------------------------------------
// Failure-incident throttling
//
// Without this, a jig failing on a cron every N minutes emails the user on
// every run (the 20-emails-overnight problem). Policy per jig:
//   1st failure  → normal failure email.
//   2nd failure  → one "failed again — pausing repeat alerts" email.
//   3rd+ failure → silent, counted. Every 24h while still failing, one
//                  summary email with the failure count + a fix CTA.
//   next success → incident cleared; a future failure starts fresh.
// State lives in the settings table (like system-notify's debounce) so it
// survives restarts. Auto-repair is NOT throttled — every failure stays a
// repair candidate.
// ---------------------------------------------------------------------------

const INCIDENT_KEY_PREFIX = "failure_incident."
const SUMMARY_INTERVAL_MS = 24 * 60 * 60 * 1000

export type FailureIncident = {
  firstFailedAt: number
  lastFailedAt: number
  /** Total failures since the incident started. */
  failCount: number
  /** Emails sent for this incident (1 = initial, 2 = pause notice, 3+ = summaries). */
  emailsSent: number
  lastEmailAt: number
  /** failCount when the last email went out — the delta is "fails since we last told you". */
  failCountAtLastEmail: number
}

function incidentKey(jigId: string): string {
  return `${INCIDENT_KEY_PREFIX}${jigId}`
}

/** The open incident for a jig, or null once a real run has succeeded. Read by the audit report too. */
export function readFailureIncident(jigId: string): FailureIncident | null {
  const raw = getSetting<Partial<FailureIncident>>(incidentKey(jigId))
  if (!raw || typeof raw !== "object" || typeof raw.failCount !== "number") return null
  return raw as FailureIncident
}

export function clearFailureIncident(jigId: string): void {
  if (readFailureIncident(jigId)) setSetting(incidentKey(jigId), null)
}

function dashboardJigUrl(jigId: string): string {
  const base = publicUrl() ?? `http://localhost:${process.env.JIG_DASHBOARD_PORT ?? "3141"}`
  return `${base}/jigs/${jigId}`
}

export async function maybeNotifyRunFailure(
  jigId: string,
  runId: number,
  dryRun: boolean,
  deps: {
    getRun?: typeof getRun
    notify?: typeof notify
    startAutoRepair?: typeof maybeStartAutoRepair
    now?: () => number
  } = {}
): Promise<boolean> {
  if (dryRun || runId <= 0) return false

  const run = (deps.getRun ?? getRun)(runId)
  if (!run) return false
  if (run.status === "success") {
    // Recovered — next failure is a new incident (and emails again).
    clearFailureIncident(jigId)
    return false
  }
  if (run.status !== "fail") return false
  if (isCancellationMessage(run.error) || isCancellationMessage(run.output)) return false

  const now = (deps.now ?? Date.now)()
  const incident = readFailureIncident(jigId)
  const doNotify = deps.notify ?? notify

  // Same chokepoint covers auto-repair: every real failure is a candidate,
  // and the guards in run-repair.ts decide whether this one warrants a fix.
  // Deliberately outside the email throttle below.
  void (deps.startAutoRepair ?? maybeStartAutoRepair)(jigId, runId).catch(() => {})

  if (!incident) {
    // First failure — email normally and open an incident.
    await doNotify({
      title: `Jig "${jigId}" failed`,
      body: formatFailureBody({
        jigId,
        runId,
        error: run.error,
        failedStep: summarizeFailureStreak([run]).failedStep,
        startedAt: run.started_at,
        durationMs: run.duration_ms,
      }),
      kind: "fail",
      jigId,
      runId,
    })
    setSetting(incidentKey(jigId), {
      firstFailedAt: now,
      lastFailedAt: now,
      failCount: 1,
      emailsSent: 1,
      lastEmailAt: now,
      failCountAtLastEmail: 1,
    } satisfies FailureIncident)
    return true
  }

  incident.failCount += 1
  incident.lastFailedAt = now

  if (incident.emailsSent === 1) {
    // Second failure on the same problem — say so once, then go quiet.
    await doNotify({
      title: `Jig "${jigId}" failed again — pausing repeat alerts`,
      body: [
        `This jig has now failed ${incident.failCount} times, likely on the same problem.`,
        `To keep your inbox usable, further failures won't send individual emails.`,
        `If it's still failing in 24 hours, you'll get one summary with the count.`,
        ``,
        run.error ? `Latest error: ${run.error}` : null,
        `Fix it: ${dashboardJigUrl(jigId)}`,
      ].filter((l): l is string => l !== null).join("\n"),
      kind: "fail",
      jigId,
      runId,
    })
    incident.emailsSent = 2
    incident.lastEmailAt = now
    incident.failCountAtLastEmail = incident.failCount
    setSetting(incidentKey(jigId), incident)
    return true
  }

  if (now - incident.lastEmailAt >= SUMMARY_INTERVAL_MS) {
    // Still failing a day later — one summary, then quiet for another day.
    const sinceLastEmail = incident.failCount - incident.failCountAtLastEmail
    const hours = Math.round((now - incident.lastEmailAt) / (60 * 60 * 1000))
    await doNotify({
      title: `Jig "${jigId}" is still failing — ${sinceLastEmail} failures in the last ${hours}h`,
      body: [
        `This jig kept failing after the earlier alerts (${incident.failCount} failures total since ${new Date(incident.firstFailedAt).toISOString()}).`,
        `Auto-repair hasn't resolved it, so it probably needs something only you can do — reconnecting a service, fixing credentials, or editing the jig.`,
        ``,
        run.error ? `Latest error: ${run.error}` : null,
        ``,
        `Fix it now: ${dashboardJigUrl(jigId)}`,
      ].filter((l): l is string => l !== null).join("\n"),
      kind: "fail",
      jigId,
      runId,
    })
    incident.emailsSent += 1
    incident.lastEmailAt = now
    incident.failCountAtLastEmail = incident.failCount
    setSetting(incidentKey(jigId), incident)
    return true
  }

  // Muted window — count it, send nothing.
  setSetting(incidentKey(jigId), incident)
  return false
}

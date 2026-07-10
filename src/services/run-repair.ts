/**
 * Auto-repair on repeated run failure ("self-healing jigs").
 *
 * When a jig fails twice in a row, start a normal authoring session seeded
 * with the failing step + error, and open an email thread for it. The email
 * bridge (email-agent-bridge.ts, `approval: "propose"`) relays the outcome —
 * proposed diff, question, or why it can't be fixed — and the owner replies
 * "apply" to ship or with changes to revise. Nothing ships without approval.
 *
 * Stateless by design: every decision derives from the runs table, the
 * pending store, and the jig edit lock — no new tables. The 2–3 streak
 * window is the runaway brake: at most two attempts per failure streak,
 * self-recovering if the first died mid-session, reset by any success.
 *
 * The guards check mechanical facts only — they never interpret WHY a run
 * failed. The agent is the failure classifier: its instruction says to fix
 * what a code edit can fix and to explain the blocker (revoked access,
 * external outage, …) when it can't. Both outcomes reach the owner through
 * the same email thread. Keeping error-reason taxonomies out of this file is
 * deliberate; the failure space is open-ended and prefix/keyword lists rot.
 */
import { getJigRuns, recordEmailThread, setEmailThreadSession, type RunRow, type StepRow } from "../db.js"
import { logSessionEvent } from "../debug/session-log.js"
import { startAgentSession } from "./agent-service.js"
import { getAgentMailSettings, isAgentMailConfigured, sendAgentMailEmail } from "./agentmail.js"
import { mintReplyToken, replyTokenFooter, subjectWithReplyToken } from "./reply-token.js"
import { attachEmailBridge } from "./email-agent-bridge.js"
import { getPending } from "./jig-store.js"

const STREAK_MIN = 2
const STREAK_MAX = 3
const ERROR_EXCERPT_CHARS = 1500

export interface RepairDeps {
  getJigRuns?: typeof getJigRuns
  getPending?: typeof getPending
  startAgentSession?: typeof startAgentSession
  openEmailThread?: typeof openEmailThread
}

/**
 * Called after every real run failure (see maybeNotifyRunFailure). Returns the
 * repair session id when an attempt started, or null with the skip reason logged.
 */
export async function maybeStartAutoRepair(jigId: string, runId: number, deps: RepairDeps = {}): Promise<string | null> {
  const latest = latestFailureStreak((deps.getJigRuns ?? getJigRuns)(jigId, STREAK_MAX + 2))

  let reason: string | null = null
  if (latest.streak < STREAK_MIN) return null // ordinary single failure — not our business
  if (latest.streak > STREAK_MAX) reason = `streak ${latest.streak} past window — already attempted`
  else if ((deps.getPending ?? getPending)(jigId)) reason = "a pending fix already awaits approval"

  if (!reason) {
    try {
      const { sessionId } = await (deps.startAgentSession ?? startAgentSession)({
        instruction: buildRepairInstruction(jigId, latest),
        jigId,
      })
      console.log(`[repair] ${jigId} failed ${latest.streak}× — started repair session ${sessionId}`)
      logSessionEvent({ source: "repair", event: "session-started", jigId, runId, sessionId, streak: latest.streak })
      await (deps.openEmailThread ?? openEmailThread)(jigId, sessionId)
      return sessionId
    } catch (e) {
      reason = `could not start session: ${(e as Error)?.message ?? e}`
    }
  }

  logSessionEvent({ source: "repair", event: "skip", jigId, runId, reason })
  return null
}

/** Consecutive-failure streak of the finished runs, plus the sharpest error
 * text of the latest one (the failing step's error beats the run rollup). */
function latestFailureStreak(runs: (RunRow & { steps: StepRow[] })[]): { streak: number; error: string; failedStep?: string } {
  const finished = runs.filter((r) => r.status !== "running")
  let streak = 0
  while (streak < finished.length && finished[streak].status === "fail") streak++
  const latest = finished[0]
  const failedStep = latest?.steps.find((s) => s.status === "fail")
  return {
    streak,
    error: (failedStep?.error || latest?.error || "(no error message)").trim(),
    failedStep: failedStep?.label,
  }
}

function buildRepairInstruction(jigId: string, f: { streak: number; error: string; failedStep?: string }): string {
  const excerpt = f.error.length > ERROR_EXCERPT_CHARS ? `${f.error.slice(0, ERROR_EXCERPT_CHARS)}…` : f.error
  return [
    `The jig "${jigId}" has failed ${f.streak} runs in a row. Latest failure${f.failedStep ? ` at step "${f.failedStep}"` : ""}:`,
    "",
    excerpt,
    "",
    "Diagnose the root cause and fix the jig with the smallest change that resolves it, honoring the jig's intent.",
    "At the fix site, leave a one-line // comment stating what runtime failure it prevents.",
    "If the failure is not fixable by editing the jig (external outage, revoked access, provider-side issue), do not make a speculative change — explain the concrete blocker instead.",
  ].join("\n")
}

/**
 * Open the email thread the repair session reports into: one kickoff email,
 * thread mapped to the session, bridge attached in propose mode (owner must
 * reply "apply" — an unsolicited fix never self-ships). Skipped silently when
 * inbound email isn't set up; the fix still lands on the dashboard as pending.
 */
async function openEmailThread(jigId: string, sessionId: string): Promise<void> {
  if (!isAgentMailConfigured()) return
  try {
    const token = mintReplyToken()
    const { threadId, messageId } = await sendAgentMailEmail({
      to: getAgentMailSettings().owner!,
      subject: subjectWithReplyToken(`Jig "${jigId}" failed twice — working on a fix`, token),
      text: `This jig has now failed twice in a row, so I'm diagnosing it. I'll reply here with a proposed fix for your approval.${replyTokenFooter(token)}`,
    })
    // 'propose' persists on the thread so every reply (revision, question) keeps
    // the approval gate — the fix ships only on an explicit "apply".
    recordEmailThread(threadId, jigId, "propose", token)
    setEmailThreadSession(threadId, sessionId)
    attachEmailBridge(sessionId, threadId, messageId, { approval: "propose" })
  } catch (e) {
    console.error(`[repair] failed to open email thread for ${jigId}: ${(e as Error)?.message ?? e}`)
  }
}

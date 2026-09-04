/**
 * Failure alerts — emails the owner when a jig run fails.
 *
 * Delivery is AgentMail only, deliberately. Alerts used to be able to ride an
 * MCP tool the user had connected (Telegram, Gmail, …), but the most common
 * reason a jig fails is that one of those connections lost its auth — so the
 * alert about the broken connection went out over the broken connection. An
 * AgentMail send is one HTTPS call with an API key: the only moving parts are
 * the network and the credentials table. Same reasoning as system-notify.ts.
 *
 * Invariants:
 *   - notify() NEVER throws, even with a dead inbox or malformed settings.
 *     Callers can fire-and-forget.
 *   - Gated by `notifyOnFailure` in the AgentMail settings row, which is the
 *     single on/off switch for alerting.
 */
import { recordEmailThread } from "../db.js"
import { mintReplyToken, replyTokenFooter, subjectWithReplyToken } from "./reply-token.js"
import {
  canSendAgentMail,
  getAgentMailSettings,
  isAgentMailConfigured,
  sendAgentMailEmail,
} from "./agentmail.js"
import { publicUrl } from "../config/runtime.js"

export async function notify(opts: {
  title: string
  body: string
  kind: "fail"
  jigId?: string
  runId?: number
  /** Bypass the notifyOnFailure gate for explicit test sends. */
  ignoreTriggerGate?: boolean
  /** Override for tests — inject a custom sender instead of calling AgentMail. */
  sendEmail?: typeof sendAgentMailEmail
}): Promise<boolean> {
  try {
    const { owner, notifyOnFailure } = getAgentMailSettings()
    if (!opts.ignoreTriggerGate && !notifyOnFailure) return false
    if (!canSendAgentMail() || !owner) return false

    // Reply-to-edit additionally needs the inbound webhook and a jig to route
    // the reply to; without those the alert still goes out, just not repliable.
    const repliable = isAgentMailConfigured() && !!opts.jigId
    const token = repliable ? mintReplyToken() : null
    const text = token
      ? `${opts.body}\n\nReply to this email to fix the jig — your reply goes straight to its authoring agent.${replyTokenFooter(token)}`
      : opts.body
    const subject = token ? subjectWithReplyToken(opts.title, token) : opts.title

    const send = opts.sendEmail ?? sendAgentMailEmail
    const { threadId } = await send({ to: owner, subject, text })
    if (token) recordEmailThread(threadId, opts.jigId!, "auto", token)
    return true
  } catch (e) {
    console.warn("[notify] failure alert not sent:", (e as Error)?.message ?? String(e))
    return false
  }
}

// ---------------------------------------------------------------------------
// Body formatter
// ---------------------------------------------------------------------------

export function formatFailureBody(opts: {
  jigId: string
  runId?: number
  error: string | null
  /** Label of the step that failed, when the run got that far. */
  failedStep?: string
  startedAt: string | null
  durationMs: number | null
  dashboardBaseUrl?: string
}): string {
  const lines: string[] = []
  if (opts.runId != null) lines.push(`Run: #${opts.runId}`)
  if (opts.failedStep) lines.push(`Failed step: ${opts.failedStep}`)
  if (opts.error) lines.push(`Error: ${opts.error}`)
  if (opts.startedAt) lines.push(`Started: ${opts.startedAt}`)
  if (opts.durationMs != null) {
    const seconds = Math.round(opts.durationMs / 1000)
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    lines.push(`Duration: ${m}m ${s}s`)
  }
  const base = opts.dashboardBaseUrl
    ?? publicUrl()
    ?? `http://localhost:${process.env.JIG_DASHBOARD_PORT ?? "3141"}`
  lines.push(`Link: ${base}/jigs/${opts.jigId}`)
  return lines.join("\n")
}

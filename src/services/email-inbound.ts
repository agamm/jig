/**
 * Inbound email webhook — turns a reply to a jig's failure email into an
 * authoring-agent edit.
 *
 * Flow: AgentMail POSTs a `message.received` event when the owner replies. We
 * verify the Svix signature, confirm it's an authenticated reply from the owner
 * about a known jig, then hand the reply text to the authoring agent and bridge
 * the session back to the thread (see email-agent-bridge.ts).
 *
 * Security gates (all must pass, else the reply is ignored):
 *   1. Valid Svix signature — only AgentMail can deliver.
 *   2. event_type is exactly "message.received" — AgentMail routes failed-auth
 *      mail to .spam/.blocked/.unauthenticated, which we drop. This offloads
 *      SPF/DKIM/DMARC to AgentMail.
 *   3. The From address matches the configured owner.
 *   4. The thread maps to a known jig.
 *   5. The reply echoes the thread's secret token (defeats From spoofing — the
 *      token reached only the owner's inbox). Grandfathered for pre-v20 threads.
 */
import { getEmailThread, setEmailThreadSession, type EmailThreadRow } from "../db.js"
import { getAgentMailSettings, replyAgentMail, verifyAgentMailWebhook } from "./agentmail.js"
import {
  approvePendingByJig,
  closeAgentSession,
  findApprovableSessionForJig,
  getAgentSessionStatus,
  pushAgentMessage,
  startAgentSession,
  validatePendingFix,
} from "./agent-service.js"
import { classifyApprovalReply } from "./classify-reply.js"
import { replyCarriesToken } from "./reply-token.js"
import { attachEmailBridge } from "./email-agent-bridge.js"
import { getPending } from "./jig-store.js"
import { summarizeJigChange } from "./summarize-change.js"

/** Pull the bare address out of `Name <a@b.com>` or `a@b.com`. */
function parseAddress(raw: string | undefined | null): string | null {
  if (!raw) return null
  const angle = raw.match(/<([^>]+)>/)
  const addr = (angle ? angle[1] : raw).trim().toLowerCase()
  return addr.includes("@") ? addr : null
}

/** Drop quoted history so only the user's new text becomes the instruction. */
function stripQuotedReply(text: string): string {
  const lines = text.split(/\r?\n/)
  const out: string[] = []
  for (const line of lines) {
    if (/^>/.test(line)) break
    if (/^On .+wrote:\s*$/.test(line)) break
    if (/^-{2,}\s*Original Message\s*-{2,}/i.test(line)) break
    if (/^_{5,}/.test(line)) break // Outlook divider
    out.push(line)
  }
  return out.join("\n").trim()
}

export async function handleInboundEmail(
  rawBody: string,
  headers: Headers,
): Promise<{ status: number; body: unknown }> {
  if (!verifyAgentMailWebhook(rawBody, headers)) {
    return { status: 401, body: { error: "Invalid webhook signature" } }
  }

  let payload: any
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return { status: 400, body: { error: "Invalid JSON" } }
  }

  // Gate 2: only authenticated inbound mail.
  if (payload?.event_type !== "message.received") {
    return { status: 200, body: { ignored: "not an authenticated message.received event" } }
  }

  const message = payload.message ?? {}
  const threadId: string | undefined = message.thread_id
  const messageId: string | undefined = message.message_id
  if (!threadId || !messageId) {
    return { status: 200, body: { ignored: "missing thread/message id" } }
  }

  // Gate 3: sender must be the configured owner.
  const owner = parseAddress(getAgentMailSettings().owner)
  const sender = parseAddress(message.from)
  if (!owner || !sender || sender !== owner) {
    console.warn(`[email] ignoring inbound from non-owner sender: ${sender ?? "unknown"}`)
    return { status: 200, body: { ignored: "sender is not the owner" } }
  }

  // Gate 4: thread must map to a jig.
  const thread = getEmailThread(threadId)
  if (!thread) {
    return { status: 200, body: { ignored: "unknown thread" } }
  }

  // Gate 5: the reply must echo the thread's secret token. Gate 3 is only a
  // From-header match, which SMTP lets an attacker spoof; the token was placed
  // in the outbound subject + body and delivered ONLY to the owner's inbox, so a
  // spoofed reply that never saw the email can't produce it. Check the raw body
  // (quoted history) and subject. Pre-v20 threads have no token — grandfathered.
  if (thread.reply_token) {
    const subject: string | undefined = typeof message.subject === "string" ? message.subject : undefined
    if (!replyCarriesToken(thread.reply_token, { subject, text: message.text })) {
      console.warn(`[email] ignoring reply missing the thread token for jig ${thread.jig_id}`)
      await replyAgentMail({
        messageId,
        text: "⚠️ I couldn't verify that reply — the security reference was missing. Reply again keeping the quoted message and its \"reply ref\" line, or edit this jig on the dashboard.",
      }).catch(() => {})
      return { status: 200, body: { ignored: "reply token missing or mismatched" } }
    }
  }

  const instruction = stripQuotedReply(message.text ?? "")
  if (!instruction) {
    return { status: 200, body: { ignored: "empty instruction" } }
  }

  // When a fix is awaiting approval (see run-repair.ts), a reply that approves
  // it ships it instead of going to the authoring agent. Intent is read by the
  // LLM — replies are free-form. Guard: if the session is waiting on a
  // question, the reply (e.g. a bare "yes") answers that question instead.
  if (
    hasPendingFix(thread.jig_id) &&
    !awaitingQuestion(thread.agent_session_id) &&
    (await classifyApprovalReply(instruction))
  ) {
    return applyPendingFix(thread, threadId, messageId)
  }

  // Acknowledge immediately so the thread shows we received it and are working —
  // the authoring agent can take a while, and the final reply lands later.
  // Best-effort and awaited so the ack always precedes the result.
  await replyAgentMail({ messageId, text: "👀 On it — editing the jig now. I'll reply here when it's done." }).catch(() => {})

  // Propose threads (unsolicited auto-repair) keep proposing across revisions
  // and question-answers — the fix ships only on an explicit "apply", not on
  // any reply. The mode is persisted on the thread, so it survives beyond the
  // first reply (a plain restart would default to auto and silently self-ship).
  const bridgeOpts = thread.approval === "propose" ? { approval: "propose" as const } : undefined

  // Continue an in-flight session if it's waiting on the user (e.g. an ask_user
  // question) or holding an unapproved edit; otherwise start a fresh session.
  const liveSessionId = continuableSession(thread.agent_session_id, thread.jig_id)
  try {
    if (liveSessionId) {
      await pushAgentMessage(liveSessionId, { message: instruction })
      attachEmailBridge(liveSessionId, threadId, messageId, bridgeOpts)
    } else {
      const { sessionId } = await startAgentSession({ instruction, jigId: thread.jig_id })
      // Record the session on the thread before bridging so a fast-settling
      // session releases the mapping cleanly.
      setEmailThreadSession(threadId, sessionId)
      attachEmailBridge(sessionId, threadId, messageId, bridgeOpts)
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    console.error(`[email] failed to start/continue authoring session: ${msg}`)
    // Don't leave the reply unanswered — the whole UX is the email round-trip.
    // Name the actual blocker when we know it: a bare missing-connections
    // message with no specifics sends the user into a retry loop that can
    // never succeed.
    const details = (e as { details?: Record<string, unknown> })?.details
    const missingConnections = [
      ...(Array.isArray(details?.requiredConnections) ? details.requiredConnections as string[] : []),
      ...(Array.isArray(details?.unknownConnections) ? details.unknownConnections as string[] : []),
    ]
    const hint = missingConnections.length
      ? `This change needs connections that aren't set up yet: ${missingConnections.join(", ")}. ` +
        `Connect them on the dashboard Connections page, then send your reply again.`
      : /already editing/i.test(msg)
        ? "A session is already editing this jig — try your reply again in a moment."
        : "Something went wrong applying that change. Try replying again."
    await replyAgentMail({ messageId, text: `⚠️ ${hint}` }).catch(() => {})
    return { status: 200, body: { error: "failed to process reply" } }
  }

  return { status: 200, body: { ok: true, jigId: thread.jig_id } }
}

/**
 * A session can continue this thread if it's waiting on the user (question or
 * draft approval), or settled "done" while its edit still awaits approval — a
 * reply then revises that edit with the session's full context
 * (pushAgentMessage rebuilds the prompt around the draft code).
 */
function continuableSession(sessionId: string | null, jigId: string): string | null {
  if (!sessionId) return null
  try {
    const status = getAgentSessionStatus(sessionId, 0).status
    if (status === "waiting") return sessionId
    if (status === "done" && hasPendingFix(jigId)) return sessionId
  } catch {
    // session gone — start fresh below
  }
  return null
}

function hasPendingFix(jigId: string): boolean {
  try {
    return getPending(jigId) != null
  } catch {
    return false
  }
}

/** Waiting on an ask_user question (waiting without a draft), per the bridge's
 * own convention — approvals must not swallow answers to questions. */
function awaitingQuestion(sessionId: string | null): boolean {
  if (!sessionId) return false
  try {
    const s = getAgentSessionStatus(sessionId, 0)
    return s.status === "waiting" && !s.draftApproval
  } catch {
    return false
  }
}

/** Ship the pending fix the owner just approved and confirm in-thread.
 * Approval is by jigId, not the repair session — the pending version is
 * durable in the store and ships even if the session was pruned or released. */
async function applyPendingFix(
  thread: EmailThreadRow,
  threadId: string,
  messageId: string,
): Promise<{ status: number; body: unknown }> {
  const jigId = thread.jig_id
  // Re-check the fix still passes before shipping (no human eyeballed it), and
  // capture the diff before approval promotes and clears the pending version.
  if (!(await validatePendingFix(jigId))) {
    await replyAgentMail({
      messageId,
      text: "⚠️ Couldn't apply the fix — it no longer passes the jig check. Review it on the dashboard.",
    }).catch(() => {})
    return { status: 200, body: { error: "apply failed", jigId } }
  }
  let diff: string | null = null
  try {
    diff = getPending(jigId)?.diff ?? null
  } catch {
    // best-effort — only used for the confirmation summary
  }

  const approved = await approvePendingByJig(jigId).catch(() => false)
  if (!approved) {
    await replyAgentMail({
      messageId,
      text: "⚠️ Couldn't apply the fix — review it on the dashboard.",
    }).catch(() => {})
    return { status: 200, body: { error: "apply failed", jigId } }
  }

  // Settle any live repair session for this jig so it doesn't dangle.
  const staleSession = thread.agent_session_id ?? findApprovableSessionForJig(jigId)
  if (staleSession) await closeAgentSession(staleSession).catch(() => {})
  setEmailThreadSession(threadId, null)

  const summary = diff ? await summarizeJigChange(diff) : null
  await replyAgentMail({
    messageId,
    text: `✅ Shipped to ${jigId}.${summary ? `\n\n${summary}` : ""}`,
  }).catch(() => {})
  return { status: 200, body: { ok: true, applied: true, jigId } }
}

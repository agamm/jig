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
import { getEmailThread, getJigByInboxId, getSchedule, setEmailThreadSession, type EmailThreadRow, type JigInboxRow } from "../db.js"
import { startBackgroundRun } from "./background-run.js"
import { hasActiveRunForJig } from "./run-store.js"
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

/**
 * Side effects of the jig-data path, injected so the gate sequence above can be
 * tested without a network or a live scheduler. The authoring path keeps its own
 * imports; it is exercised through the agent-service tests instead.
 */
export interface InboundEmailDeps {
  startRun: (jigId: string, params: Record<string, unknown>) => Promise<boolean>
  reply: (opts: { messageId: string; text: string; fromInboxId?: string }) => Promise<void>
  isRunning: (jigId: string) => boolean
  getSchedule: (jigId: string) => { enabled: boolean } | null
}

const realInboundDeps: InboundEmailDeps = {
  startRun: (jigId, params) => startBackgroundRun(jigId, params),
  reply: (opts) => replyAgentMail(opts),
  isRunning: hasActiveRunForJig,
  getSchedule: (jigId) => {
    const row = getSchedule(jigId)
    return row ? { enabled: row.enabled === 1 } : null
  },
}

export async function handleInboundEmail(
  rawBody: string,
  headers: Headers,
  deps: InboundEmailDeps = realInboundDeps,
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

  // Before thread routing: mail that arrived in a jig's OWN inbox is data for
  // that jig, not an instruction about it. Routing on the inbox rather than the
  // thread is what makes a first-contact email work at all, a brand-new
  // message has no thread mapping and would otherwise be dropped below.
  const inboxId: string | undefined = message.inbox_id
  const jigInbox = inboxId ? getJigByInboxId(inboxId) : null
  if (jigInbox) {
    return deliverEmailToJig(jigInbox, message, messageId, deps)
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
  // (quoted history) and subject. A thread with no token is not trusted either —
  // every thread jig creates now carries one.
  const subject: string | undefined = typeof message.subject === "string" ? message.subject : undefined
  if (!thread.reply_token || !replyCarriesToken(thread.reply_token, { subject, text: message.text })) {
    console.warn(`[email] ignoring reply missing the thread token for jig ${thread.jig_id}`)
    await replyAgentMail({
      messageId,
      text: "⚠️ I couldn't verify that reply — the security reference was missing. Reply again keeping the quoted message and its \"reply ref\" line, or edit this jig on the dashboard.",
    }).catch(() => {})
    return { status: 200, body: { ignored: "reply token missing or mismatched" } }
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
 * Run an email-triggered jig with the message as its input.
 *
 * No reply token here, unlike the authoring path. A token guards edits because
 * a spoofed reply would otherwise rewrite a jig's code; this path only hands
 * text to a jig that already decided to accept mail. The gate that matters is
 * still upstream: we subscribe only to `message.received`, and AgentMail routes
 * anything failing SPF/DKIM/DMARC to `.unauthenticated`/`.spam`/`.blocked`
 * instead, so the owner match above is on authenticated mail, not on a bare
 * From header.
 *
 * The body still reaches an `llm()` or `agent()` call inside the jig, so it is
 * untrusted input in the prompt-injection sense. That is the jig author's
 * problem to scope (see the tool allowlist per step), not something this
 * function can decide.
 */
export interface InboundEmailParams {
  email: {
    from: string | null
    subject: string | null
    text: string
    messageId: string
    threadId: string | null
    receivedAt: string
  }
}

/**
 * What the jig sees as ctx.params. Prefers AgentMail's own reply extraction
 * (Talon) over raw text: on a threaded reply, `text` still carries the whole
 * quoted history, which would hand the jig its own last email as new input.
 * When AgentMail supplies no extraction, fall back to the same line heuristics
 * the authoring path uses rather than to the raw body, so the documented
 * "quoted history already stripped" contract holds either way.
 */
export function emailRunParams(message: any, messageId: string, now = () => new Date()): InboundEmailParams | null {
  const extracted = typeof message.extracted_text === "string" ? message.extracted_text.trim() : ""
  const text = extracted || stripQuotedReply(typeof message.text === "string" ? message.text : "")
  if (!text) return null
  return {
    email: {
      from: parseAddress(message.from),
      subject: typeof message.subject === "string" ? message.subject : null,
      text,
      messageId,
      threadId: typeof message.thread_id === "string" ? message.thread_id : null,
      receivedAt: typeof message.timestamp === "string" ? message.timestamp : now().toISOString(),
    },
  }
}

async function deliverEmailToJig(
  jigInbox: JigInboxRow,
  message: any,
  messageId: string,
  deps: InboundEmailDeps,
): Promise<{ status: number; body: unknown }> {
  const jigId = jigInbox.jig_id
  const params = emailRunParams(message, messageId)
  if (!params) {
    return { status: 200, body: { ignored: "empty email body", jigId } }
  }

  // A paused jig stays paused, the same way the webhook trigger refuses to fire
  // one (see scheduler/webhooks.ts). Without this, disabling a misbehaving
  // email jig on the dashboard would not actually stop it.
  const schedule = deps.getSchedule(jigId)
  if (schedule && !schedule.enabled) {
    await deps.reply({
      messageId,
      fromInboxId: jigInbox.inbox_id,
      text: "This jig is paused, so I did not run it. Re-enable it on the dashboard and send this again.",
    }).catch(() => {})
    return { status: 200, body: { ignored: "schedule disabled", jigId } }
  }

  // Checked here rather than inferred from startRun's return value: a run can
  // fail to start for several unrelated reasons (missing connection, no active
  // version), and reporting all of them as "already running" sends the user
  // into a resend loop that can never succeed.
  if (deps.isRunning(jigId)) {
    await deps.reply({
      messageId,
      fromInboxId: jigInbox.inbox_id,
      text: "This jig was already running, so I did not start a second copy. Send this again in a moment.",
    }).catch(() => {})
    return { status: 200, body: { error: "run in progress", jigId } }
  }

  // Fire and forget, like the webhook trigger. Awaiting the run would hold the
  // Svix POST open for its whole duration (startBackgroundRun awaits the run to
  // completion), and AgentMail would time out and redeliver, which either
  // double-files the item or reports a spurious failure for a run that is in
  // fact succeeding.
  void deps.startRun(jigId, params as unknown as Record<string, unknown>).catch((e) => {
    console.error(`[email] failed to run ${jigId} from inbound mail: ${(e as Error)?.message ?? e}`)
  })

  return { status: 202, body: { ok: true, jigId, delivered: true } }
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

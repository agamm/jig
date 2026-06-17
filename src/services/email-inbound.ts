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
 */
import { getEmailThread, setEmailThreadSession } from "../db.js"
import { getAgentMailSettings, replyAgentMail, verifyAgentMailWebhook } from "./agentmail.js"
import { getAgentSessionStatus, pushAgentMessage, startAgentSession } from "./agent-service.js"
import { attachEmailBridge } from "./email-agent-bridge.js"

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

  const instruction = stripQuotedReply(message.text ?? "")
  if (!instruction) {
    return { status: 200, body: { ignored: "empty instruction" } }
  }

  // Continue an in-flight session if it's waiting on the user (e.g. an ask_user
  // question); otherwise start a fresh edit session for the jig.
  const liveSessionId = liveWaitingSession(thread.agent_session_id)
  try {
    if (liveSessionId) {
      await pushAgentMessage(liveSessionId, { message: instruction })
      attachEmailBridge(liveSessionId, threadId, messageId)
    } else {
      const { sessionId } = await startAgentSession({ instruction, jigId: thread.jig_id })
      // Record the session on the thread before bridging so a fast-settling
      // session releases the mapping cleanly.
      setEmailThreadSession(threadId, sessionId)
      attachEmailBridge(sessionId, threadId, messageId)
    }
  } catch (e) {
    const msg = (e as Error)?.message ?? String(e)
    console.error(`[email] failed to start/continue authoring session: ${msg}`)
    // Don't leave the reply unanswered — the whole UX is the email round-trip.
    // A 409 here means a session is already editing this jig.
    const hint = /already editing/i.test(msg)
      ? "A session is already editing this jig — try your reply again in a moment."
      : "Something went wrong applying that change. Try replying again."
    await replyAgentMail({ messageId, text: `⚠️ ${hint}` }).catch(() => {})
    return { status: 200, body: { error: "failed to process reply" } }
  }

  return { status: 200, body: { ok: true, jigId: thread.jig_id } }
}

/** A session id is "live" for continuation only if it exists and is waiting. */
function liveWaitingSession(sessionId: string | null): string | null {
  if (!sessionId) return null
  try {
    return getAgentSessionStatus(sessionId, 0).status === "waiting" ? sessionId : null
  } catch {
    return null
  }
}

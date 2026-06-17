/**
 * Email ↔ authoring-agent bridge.
 *
 * When a reply to a jig's failure email spins up (or continues) an authoring
 * session, this watches that session and relays its progress back into the mail
 * thread:
 *   - the agent asks a question  → reply the question (thread stays open so the
 *                                   user's next reply continues the same session)
 *   - the agent produces an edit → auto-approve it and reply "shipped"
 *   - the agent errors / answers → reply the message
 *
 * Auto-approve is the chosen policy: an authenticated owner reply ships the edit
 * with no dashboard step (see email-inbound.ts for the auth gate).
 */
import { publicUrl } from "../config/runtime.js"
import { setEmailThreadSession } from "../db.js"
import {
  autoApproveSession,
  getAgentSessionStatus,
  subscribeToSessionFrames,
} from "./agent-service.js"
import { replyAgentMail } from "./agentmail.js"

function latestText(events: Array<{ type: string; content?: string }>): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]
    if (e.type === "text" && e.content) return e.content
  }
  return ""
}

function jigLink(jigId: string | undefined): string {
  if (!jigId) return ""
  const base = publicUrl() ?? `http://localhost:${process.env.JIG_DASHBOARD_PORT ?? "3141"}`
  return `\n\n${base}/jigs/${jigId}`
}

async function reply(messageId: string, text: string): Promise<void> {
  try {
    await replyAgentMail({ messageId, text })
  } catch (e) {
    console.error(`[email] failed to reply into thread: ${(e as Error)?.message ?? e}`)
  }
}

/**
 * Attach the bridge to a live session. `replyToMessageId` is the inbound message
 * we reply to (keeps the thread); `threadId` lets us release the session mapping
 * once the exchange settles. Fires once per settle, then unsubscribes.
 */
export function attachEmailBridge(sessionId: string, threadId: string, replyToMessageId: string): void {
  let settled = false

  const unsubscribe = subscribeToSessionFrames(sessionId, () => {
    void handleFrame()
  })

  async function handleFrame(): Promise<void> {
    if (settled) return

    let snapshot
    try {
      snapshot = getAgentSessionStatus(sessionId, 0)
    } catch {
      return // session gone — nothing to relay
    }

    const { status, draftApproval, events, jigId } = snapshot

    // Still working — wait for the next frame.
    if (status === "thinking" || status === "tool-calling") return

    // ask_user pause: a "waiting" with no draft is a question. Relay it and keep
    // the thread open; the user's reply re-enters via the inbound handler.
    if (status === "waiting" && !draftApproval) {
      settled = true
      unsubscribe()
      await reply(replyToMessageId, latestText(events) || "I have a question — what would you like me to do?")
      return
    }

    // From here the session has settled — stop listening and release the mapping.
    settled = true
    unsubscribe()

    if (status === "error") {
      setEmailThreadSession(threadId, null)
      await reply(replyToMessageId, `⚠️ Couldn't apply that change.\n\n${latestText(events)}`)
      return
    }

    // "waiting" + draftApproval (new jig) or "done" with a pending edit: approve
    // and confirm. A plain "done" with nothing pending just relays the answer.
    const approved = await autoApproveSession(sessionId).catch((e) => {
      console.error(`[email] auto-approve failed: ${(e as Error)?.message ?? e}`)
      return false
    })
    setEmailThreadSession(threadId, null)

    if (approved) {
      // Don't echo the agent's "draft ready / approve to create" line back —
      // it already shipped. Keep the confirmation clean for both create + edit.
      await reply(replyToMessageId, `✅ Shipped${jigId ? ` to ${jigId}` : ""}. The change is live.${jigLink(jigId)}`)
    } else {
      await reply(replyToMessageId, latestText(events) || "Done.")
    }
  }

  // Cover the race where the session settled before we subscribed.
  void handleFrame()
}

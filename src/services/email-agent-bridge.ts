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
 * Auto-approve is the default policy: an authenticated owner reply ships the
 * edit with no dashboard step (see email-inbound.ts for the auth gate). The
 * exception is `approval: "propose"` — used for sessions the owner never asked
 * for (auto-repair, see run-repair.ts): the edit is replied as a diff and the
 * thread stays mapped, so only an explicit "apply" reply ships it.
 */
import { publicUrl } from "../config/runtime.js"
import { setEmailThreadSession } from "../db.js"
import {
  autoApproveSession,
  getAgentSessionStatus,
  subscribeToSessionFrames,
  validatePendingFix,
} from "./agent-service.js"
import { replyAgentMail } from "./agentmail.js"
import { getPending } from "./jig-store.js"
import { summarizeJigChange } from "./summarize-change.js"

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

/** Keep proposal emails readable — long diffs continue on the dashboard. */
function excerptDiff(diff: string, maxLines = 120): string {
  const lines = diff.split("\n")
  if (lines.length <= maxLines) return diff
  return `${lines.slice(0, maxLines).join("\n")}\n… (+${lines.length - maxLines} more lines — full diff on the dashboard)`
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
export function attachEmailBridge(
  sessionId: string,
  threadId: string,
  replyToMessageId: string,
  opts: { approval?: "auto" | "propose" } = {},
): void {
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
    // Capture the diff BEFORE approval — approving promotes (and clears) pending.
    let changeDiff: string | null = null
    if (jigId) {
      try { changeDiff = getPending(jigId)?.diff ?? null } catch { /* best-effort */ }
    }

    // Propose: the owner never asked for this edit, so it must not self-ship.
    // Reply the diff and keep the thread mapped — "apply" approves it and any
    // other reply revises it (email-inbound.ts). A pending that doesn't pass
    // the jig check (max-rounds can leave a broken write) is never proposed;
    // relay the agent's own explanation instead.
    if (opts.approval === "propose") {
      if (jigId && changeDiff && (await validatePendingFix(jigId).catch(() => false))) {
        const summary = await summarizeJigChange(changeDiff)
        await reply(replyToMessageId, [
          summary ?? "I diagnosed the failure and prepared a fix.",
          "",
          excerptDiff(changeDiff),
          "",
          `Reply "apply" to ship this fix, or reply with the changes you'd like.${jigLink(jigId)}`,
        ].join("\n"))
        return
      }
      setEmailThreadSession(threadId, null)
      await reply(replyToMessageId, latestText(events) || "I couldn't prepare a fix automatically.")
      return
    }

    const approved = await autoApproveSession(sessionId).catch((e) => {
      console.error(`[email] auto-approve failed: ${(e as Error)?.message ?? e}`)
      return false
    })
    setEmailThreadSession(threadId, null)

    if (approved) {
      // Summarize what actually changed so the confirmation is useful — not just
      // "the change is live". Best-effort; falls back to a generic line.
      const summary = changeDiff ? await summarizeJigChange(changeDiff) : null
      const what = summary ? `\n\n${summary}` : " The change is live."
      await reply(replyToMessageId, `✅ Shipped${jigId ? ` to ${jigId}` : ""}.${what}${jigLink(jigId)}`)
    } else {
      await reply(replyToMessageId, latestText(events) || "Done.")
    }
  }

  // Cover the race where the session settled before we subscribed.
  void handleFrame()
}

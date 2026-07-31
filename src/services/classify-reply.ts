/**
 * Classify whether an owner's email reply approves shipping a proposed fix
 * as-is — used by the inbound webhook to route approval replies to the
 * approval gate instead of the authoring agent (see run-repair.ts).
 *
 * Uses the LLM (not keyword matching) so free-form phrasings are understood.
 * The failure mode is deliberately asymmetric: anything unclear — change
 * requests, questions, approval mixed with changes, or an unreachable LLM —
 * routes to the agent for revision. Shipping only ever happens on a clear
 * approval, which is exactly how fastYesNo fails closed.
 */
import { fastYesNo } from "../config/fast-llm.js"

const SYSTEM_PROMPT =
  "You read the owner's email reply to an automation that proposed a code fix and asked them to " +
  'reply "apply" to ship it, or reply with changes. Decide if the reply approves shipping the fix ' +
  "AS-IS — any clear affirmative counts. It is NOT an approval if the reply asks a question, " +
  "requests any change, or mixes approval with changes. Reply with exactly one word: yes or no."

const MAX_INPUT = 2000

export async function classifyApprovalReply(reply: string): Promise<boolean> {
  const text = reply.trim().slice(0, MAX_INPUT)
  if (!text) return false
  return fastYesNo(SYSTEM_PROMPT, `Reply:\n${text}`)
}

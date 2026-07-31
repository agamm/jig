/**
 * One-line, human-readable summary of a jig code change — used in the
 * reply-to-edit "shipped" confirmation email so the user sees WHAT changed,
 * not just that something did.
 *
 * Best-effort: returns null on any failure so the confirmation still sends.
 */
import { fastCompletion } from "../config/fast-llm.js"

const SYSTEM_PROMPT =
  "You summarize a change to an automation script (a 'jig') for a non-technical user. " +
  "Given a unified diff, reply with ONE plain sentence describing what behavior changed, in the " +
  "user's terms (e.g. \"Now skips emails you've already replied to.\"). No code, no file names, " +
  "no markdown, no preamble. If the change is cosmetic, say so briefly."

const MAX_DIFF = 6000

export async function summarizeJigChange(diff: string): Promise<string | null> {
  const trimmed = diff.trim()
  if (!trimmed) return null
  return fastCompletion({
    system: SYSTEM_PROMPT,
    user: `Diff:\n${trimmed.slice(0, MAX_DIFF)}`,
    maxTokens: 80,
    timeoutMs: 12_000,
  })
}

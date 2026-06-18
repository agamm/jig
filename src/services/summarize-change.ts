/**
 * One-line, human-readable summary of a jig code change — used in the
 * reply-to-edit "shipped" confirmation email so the user sees WHAT changed,
 * not just that something did.
 *
 * Direct OpenRouter fetch per the server-side rule (no SDK import in the API
 * path), cheap fast model. Best-effort: returns null on any failure so the
 * confirmation still sends without it.
 */
import { getOpenRouterApiKey } from "../config/openrouter.js"
import { getFastModel } from "../config/models.js"

const MAX_DIFF = 6000

export async function summarizeJigChange(diff: string): Promise<string | null> {
  const trimmed = diff.trim()
  if (!trimmed) return null
  try {
    const apiKey = getOpenRouterApiKey()
    if (!apiKey) return null
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: getFastModel(),
        max_tokens: 80,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You summarize a change to an automation script (a 'jig') for a non-technical user. " +
              "Given a unified diff, reply with ONE plain sentence describing what behavior changed, in the " +
              "user's terms (e.g. \"Now skips emails you've already replied to.\"). No code, no file names, " +
              "no markdown, no preamble. If the change is cosmetic, say so briefly.",
          },
          { role: "user", content: `Diff:\n${trimmed.slice(0, MAX_DIFF)}` },
        ],
      }),
      signal: AbortSignal.timeout(12_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const text = (body.choices?.[0]?.message?.content ?? "").trim()
    return text || null
  } catch {
    return null
  }
}

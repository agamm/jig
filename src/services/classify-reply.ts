/**
 * Classify whether an owner's email reply approves shipping a proposed fix
 * as-is — used by the inbound webhook to route approval replies to the
 * approval gate instead of the authoring agent (see run-repair.ts).
 *
 * Uses the LLM (not keyword matching) so free-form phrasings are understood —
 * same reasoning as classify-failure.ts. The failure mode is deliberately
 * asymmetric: anything unclear — change requests, questions, approval mixed
 * with changes, or an unreachable LLM — routes to the agent for revision.
 * Shipping only ever happens on a clear approval. Direct fetch to OpenRouter
 * per the server-side rule (no SDK import in the API server path).
 */
import { getOpenRouterApiKey } from "../config/openrouter.js"
import { getFastModel } from "../config/models.js"

const MAX_INPUT = 2000

export async function classifyApprovalReply(reply: string): Promise<boolean> {
  const text = reply.trim().slice(0, MAX_INPUT)
  if (!text) return false

  try {
    const apiKey = getOpenRouterApiKey()
    if (!apiKey) return false
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: getFastModel(),
        max_tokens: 4,
        temperature: 0,
        messages: [
          {
            role: "system",
            content:
              "You read the owner's email reply to an automation that proposed a code fix and asked them to " +
              'reply "apply" to ship it, or reply with changes. Decide if the reply approves shipping the fix ' +
              "AS-IS — any clear affirmative counts. It is NOT an approval if the reply asks a question, " +
              "requests any change, or mixes approval with changes. Reply with exactly one word: yes or no.",
          },
          { role: "user", content: `Reply:\n${text}` },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    return (body.choices?.[0]?.message?.content ?? "").trim().toLowerCase().startsWith("y")
  } catch {
    return false
  }
}

/**
 * Classify whether a failed tool-call error means the underlying connection
 * needs (re-)authentication — so the dashboard can offer a Reconnect action.
 *
 * Uses the LLM (not brittle keyword matching) so arbitrary phrasings from any
 * MCP server are understood. Cheap fast-model call, cached by error text so a
 * repeated/identical failure is classified once. Direct fetch to OpenRouter
 * per the server-side rule (no SDK import in the API server path).
 */
import { getOpenRouterApiKey } from "../config/openrouter.js"
import { getFastModel } from "../config/models.js"

type CacheEntry = { at: number; needsReauth: boolean }
const cache = new Map<string, CacheEntry>()
const TTL_MS = 60 * 60 * 1000
const MAX_INPUT = 2000

function cacheKey(errorText: string): string {
  return errorText.trim().slice(0, MAX_INPUT)
}

export async function classifyAuthFailure(errorText: string): Promise<boolean> {
  const key = cacheKey(errorText)
  if (!key) return false

  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.needsReauth

  const apiKey = getOpenRouterApiKey()
  if (!apiKey) return false

  try {
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
              "You classify automation errors. Decide if an error means the connection/integration " +
              "needs the user to (re-)authenticate or reconnect — e.g. expired/revoked/missing credentials, " +
              "OAuth or login required, session expired, 401/403 unauthorized, \"no browser available\". " +
              "It is NOT a reconnect case if the error is a bad request, rate limit, not-found, timeout, " +
              "network blip, or a logic/validation error. Reply with exactly one word: yes or no.",
          },
          { role: "user", content: `Error:\n${key}` },
        ],
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return false
    const body = (await res.json()) as { choices?: { message?: { content?: string } }[] }
    const answer = (body.choices?.[0]?.message?.content ?? "").trim().toLowerCase()
    const needsReauth = answer.startsWith("y")
    cache.set(key, { at: Date.now(), needsReauth })
    return needsReauth
  } catch {
    return false
  }
}

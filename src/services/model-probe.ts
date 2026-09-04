/**
 * One minimal completion against a model, so setup can tell "the key works"
 * from "the key works but this model refuses": age gates, region locks and
 * retired models all pass the credits check and then fail every jig.
 *
 * Successes are cached per model and key for a few minutes; failures never
 * are, so a re-check right after fixing the account sees the fix.
 */
import type { ModelProbe } from "../../shared/api.js"
import { getOpenRouterApiKey } from "../config/openrouter.js"

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
const OK_TTL_MS = 5 * 60_000
const okUntil = new Map<string, number>()

export async function probeModel(model: string): Promise<ModelProbe> {
  const apiKey = getOpenRouterApiKey()
  if (!apiKey) return { ok: false, model, error: "No OpenRouter key on this instance." }
  const cacheKey = `${model}::${apiKey.slice(-8)}`
  const until = okUntil.get(cacheKey)
  if (until && until > Date.now()) return { ok: true, model }

  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error: any) {
    return { ok: false, model, error: `Could not reach OpenRouter: ${error?.message ?? error}` }
  }

  const body = (await res.json().catch(() => null)) as { error?: { message?: unknown; metadata?: { raw?: unknown } } } | null
  // Provider refusals can arrive as an `error` body on a 200 as well as on a 4xx.
  const raw = body?.error?.message ?? body?.error?.metadata?.raw
  const message = typeof raw === "string" && raw.trim() ? raw.trim() : null
  if (res.ok && !message) {
    okUntil.set(cacheKey, Date.now() + OK_TTL_MS)
    return { ok: true, model }
  }
  const error = message ?? `OpenRouter returned HTTP ${res.status} for ${model}.`
  const fixUrl = firstUrl(error)
  return { ok: false, model, error, ...(fixUrl ? { fixUrl } : {}) }
}

/** The link a provider message tells the user to visit, if it names one. */
function firstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s)"']+/)?.[0]?.replace(/[.,;]+$/, "")
}

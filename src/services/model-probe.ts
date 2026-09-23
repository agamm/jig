/**
 * One minimal completion against a model, so setup can tell "the key works"
 * from "the key works but this model refuses": age gates, region locks and
 * retired models all pass the credits check and then fail every jig.
 *
 * Only a 4xx blocks setup. A 5xx, a network failure or OpenRouter's generic
 * "Provider returned error" is retried once and then reported as transient,
 * because an upstream hiccup says nothing about the account.
 *
 * Successes are cached per model and key for a few minutes; failures never
 * are, so a re-check right after fixing the account sees the fix.
 */
import type { ModelProbe } from "../../shared/api.js"
import { getOpenRouterApiKey } from "../config/openrouter.js"

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"
const OK_TTL_MS = 5 * 60_000
// Some upstream providers reject very small budgets outright; 16 is still a
// fraction of a cent on any model.
const PROBE_MAX_TOKENS = 16
const okUntil = new Map<string, number>()

type ErrorBody = { error?: { message?: unknown; metadata?: { raw?: unknown; provider_name?: unknown } } } | null

export async function probeModel(model: string, options: { retryDelayMs?: number } = {}): Promise<ModelProbe> {
  const apiKey = getOpenRouterApiKey()
  if (!apiKey) return { ok: false, model, error: "No OpenRouter key on this instance." }
  const cacheKey = `${model}::${apiKey.slice(-8)}`
  const until = okUntil.get(cacheKey)
  if (until && until > Date.now()) return { ok: true, model }

  let result = await attempt(model, apiKey)
  if (!result.ok && result.transient) {
    await Bun.sleep(options.retryDelayMs ?? 1_500)
    result = await attempt(model, apiKey)
  }
  if (result.ok) okUntil.set(cacheKey, Date.now() + OK_TTL_MS)
  return result
}

async function attempt(model: string, apiKey: string): Promise<ModelProbe> {
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, max_tokens: PROBE_MAX_TOKENS, messages: [{ role: "user", content: "ping" }] }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (error: any) {
    return { ok: false, model, error: `Could not reach OpenRouter: ${error?.message ?? error}`, transient: true }
  }

  const body = (await res.json().catch(() => null)) as ErrorBody
  const message = describeError(body)
  if (res.ok && !message) return { ok: true, model }

  const error = message ?? `OpenRouter returned HTTP ${res.status} for ${model}.`
  // 4xx is the account or the model saying no; anything else is the upstream having a bad moment.
  const transient = res.status >= 500 || res.ok
  const fixUrl = firstUrl(error)
  return { ok: false, model, error, ...(fixUrl ? { fixUrl } : {}), ...(transient ? { transient } : {}) }
}

/** The provider's own words when OpenRouter wrapped them in a generic message. */
function describeError(body: ErrorBody): string | null {
  const wrapper = text(body?.error?.message)
  const raw = text(body?.error?.metadata?.raw)
  const provider = text(body?.error?.metadata?.provider_name)
  if (raw && (!wrapper || /^provider returned error/i.test(wrapper))) return provider ? `${provider}: ${raw}` : raw
  return wrapper ?? raw
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

/** The link a provider message tells the user to visit, if it names one. */
function firstUrl(text: string): string | undefined {
  return text.match(/https?:\/\/[^\s)"']+/)?.[0]?.replace(/[.,;]+$/, "")
}

// Reasoning models think before answering, so a tiny budget reads as "no JSON" when it is only "no room".
const JSON_PROBE_MAX_TOKENS = 4_000
const JSON_PROBE_SCHEMA = {
  type: "object",
  properties: { answer: { type: "number" }, unit: { type: "string" } },
  required: ["answer", "unit"],
  additionalProperties: false,
}

/**
 * One strict json_schema request routed the way llm() routes it, so a model
 * that cannot return parseable JSON is refused before it becomes the default
 * rather than after every structured step starts failing.
 */
export async function probeJsonMode(model: string, options: { retryDelayMs?: number } = {}): Promise<ModelProbe> {
  const apiKey = getOpenRouterApiKey()
  if (!apiKey) return { ok: false, model, error: "No OpenRouter key on this instance." }
  let result = await jsonAttempt(model, apiKey)
  if (!result.ok && result.transient) {
    await Bun.sleep(options.retryDelayMs ?? 1_500)
    result = await jsonAttempt(model, apiKey)
  }
  return result
}

async function jsonAttempt(model: string, apiKey: string): Promise<ModelProbe> {
  let res: Response
  try {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        max_tokens: JSON_PROBE_MAX_TOKENS,
        provider: { require_parameters: true },
        messages: [{ role: "user", content: "How many centimetres are in a metre? Reply as JSON." }],
        response_format: { type: "json_schema", json_schema: { name: "response", strict: true, schema: JSON_PROBE_SCHEMA } },
      }),
      signal: AbortSignal.timeout(90_000),
    })
  } catch (error: any) {
    return { ok: false, model, error: `Could not reach OpenRouter: ${error?.message ?? error}`, transient: true }
  }

  const body = (await res.json().catch(() => null)) as (ErrorBody & { choices?: { message?: { content?: unknown }; finish_reason?: unknown }[] }) | null
  const message = describeError(body)
  if (!res.ok || message) {
    const error = `${model} failed a JSON-mode request: ${message ?? `HTTP ${res.status}`}`
    return { ok: false, model, error, ...(res.status >= 500 || res.ok ? { transient: true } : {}) }
  }
  const choice = body?.choices?.[0]
  const content = text(choice?.message?.content)
  if (!content) {
    return { ok: false, model, error: `${model} returned no JSON-mode answer (finish_reason=${String(choice?.finish_reason ?? "none")}).` }
  }
  try {
    const parsed = JSON.parse(content.replace(/^```(?:json)?\s*|\s*```$/g, ""))
    if (typeof parsed?.answer === "number") return { ok: true, model }
  } catch {}
  return { ok: false, model, error: `${model} ignored JSON mode and replied: ${content.slice(0, 120)}` }
}

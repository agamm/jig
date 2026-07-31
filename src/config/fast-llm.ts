/**
 * One-shot completions against OpenRouter for server-side classification and
 * summarization.
 *
 * These calls deliberately bypass src/sdk/llm.ts: the SDK is jig-runtime
 * machinery (spinner, run context, step scoping) and must not be pulled into
 * the API server path. Route every server-side model call through here so that
 * exclusion costs one import rather than a hand-rolled fetch per caller.
 *
 * Every helper here is best-effort by contract: a missing key, a non-2xx, a
 * timeout, or a malformed body all yield null. Callers decide the fallback,
 * and none of them should fail a user-visible operation because a nice-to-have
 * classification could not be produced.
 */
import { getFastModel } from "./models.js"
import { getOpenRouterApiKey } from "./openrouter.js"

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions"

export interface FastCompletionOptions {
  system: string
  user: string
  maxTokens: number
  timeoutMs?: number
  /** Extra body fields, e.g. OpenRouter plugins for web search. */
  body?: Record<string, unknown>
}

/** Returns the assistant's trimmed text, or null if anything went wrong. */
export async function fastCompletion(options: FastCompletionOptions): Promise<string | null> {
  const message = await fastCompletionMessage(options)
  return message?.content?.trim() || null
}

/** Web-search citations OpenRouter attaches to an annotated response. */
export interface UrlCitation {
  url?: string
  title?: string
  content?: string
}

interface CompletionMessage {
  content?: string
  annotations?: { url_citation?: UrlCitation }[]
}

/**
 * Like fastCompletion, but returns the whole message so callers can read
 * annotations (url_citation) alongside the text.
 */
export async function fastCompletionMessage(options: FastCompletionOptions): Promise<CompletionMessage | null> {
  const apiKey = getOpenRouterApiKey()
  if (!apiKey) return null

  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: getFastModel(),
        max_tokens: options.maxTokens,
        temperature: 0,
        messages: [
          { role: "system", content: options.system },
          { role: "user", content: options.user },
        ],
        ...options.body,
      }),
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
    })
    if (!res.ok) return null
    const body = (await res.json()) as { choices?: { message?: CompletionMessage }[] }
    return body.choices?.[0]?.message ?? null
  } catch {
    return null
  }
}

/**
 * A yes/no question. Returns false unless the model clearly answers yes, so an
 * unreachable model, a timeout, or an ambiguous reply all fail closed.
 */
export async function fastYesNo(system: string, user: string, timeoutMs?: number): Promise<boolean> {
  const answer = await fastCompletion({ system, user, maxTokens: 4, timeoutMs })
  return (answer ?? "").toLowerCase().startsWith("y")
}

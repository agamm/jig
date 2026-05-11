/**
 * Fetch + cache the OpenRouter model catalog for the dashboard's model picker.
 *
 * The public /api/v1/models endpoint returns static specs (pricing, context,
 * supported params). We filter to chat-completion-capable models, reshape to
 * what the UI needs, and cache in-memory for 10 minutes so repeated opens of
 * the settings page don't hammer OpenRouter.
 */
import { getOpenRouterApiKey } from "../config/openrouter.js"

export interface OpenRouterModelInfo {
  id: string
  name: string
  description?: string
  contextLength: number
  /** Prompt price in USD per million tokens (converted from per-token string). */
  promptPriceUsdPerM: number
  /** Completion price in USD per million tokens. */
  completionPriceUsdPerM: number
  /** Combined avg: (in + 3*out) / 4 — reflects typical out-heavy workloads. */
  blendedPriceUsdPerM: number
  supportsTools: boolean
  supportsReasoning: boolean
  /** Unix-seconds timestamp from OpenRouter's `created` field. 0 if missing. */
  createdAt: number
  /** Ranking index from OpenRouter's default sort order (lower = more popular). */
  rank: number
}

type CatalogCache = { at: number; data: OpenRouterModelInfo[] }
let cache: CatalogCache | null = null
const TTL_MS = 10 * 60 * 1000

function toPricePerMillion(perTokenStr: string | undefined): number {
  if (!perTokenStr) return 0
  const n = Number(perTokenStr)
  if (!Number.isFinite(n)) return 0
  return n * 1_000_000
}

export async function fetchOpenRouterModels(): Promise<{ models: OpenRouterModelInfo[]; fetchedAt: number }> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return { models: cache.data, fetchedAt: cache.at }
  }

  const headers: Record<string, string> = { "Content-Type": "application/json" }
  const key = getOpenRouterApiKey()
  if (key) headers.Authorization = `Bearer ${key}`

  const res = await fetch("https://openrouter.ai/api/v1/models", { headers })
  if (!res.ok) {
    throw new Error(`OpenRouter /models returned ${res.status}`)
  }
  const body = (await res.json()) as { data?: unknown[] }
  const raw = Array.isArray(body.data) ? body.data : []

  const models: OpenRouterModelInfo[] = raw
    .map((entry, idx) => {
      const e = entry as {
        id?: string
        name?: string
        description?: string
        context_length?: number
        created?: number
        pricing?: { prompt?: string; completion?: string }
        supported_parameters?: string[]
        architecture?: { modality?: string }
      }
      if (!e.id || !e.pricing) return null
      // Meta-routing and BYOK entries report sentinel pricing (often negative).
      // Filter both so they can't hijack the "cheap" end of the catalog.
      if (e.id === "openrouter/auto") return null
      const supported = Array.isArray(e.supported_parameters) ? e.supported_parameters : []
      const name = e.name ?? e.id
      const prompt = toPricePerMillion(e.pricing.prompt)
      const completion = toPricePerMillion(e.pricing.completion)
      if (prompt < 0 || completion < 0) return null
      const blended = (prompt + 3 * completion) / 4
      const info: OpenRouterModelInfo = {
        id: e.id,
        name,
        description: e.description,
        contextLength: e.context_length ?? 0,
        promptPriceUsdPerM: prompt,
        completionPriceUsdPerM: completion,
        blendedPriceUsdPerM: blended,
        supportsTools: supported.includes("tools"),
        supportsReasoning: supported.includes("reasoning") || supported.includes("include_reasoning"),
        createdAt: typeof e.created === "number" ? e.created : 0,
        rank: idx,
      }
      return info
    })
    .filter((x): x is OpenRouterModelInfo => x !== null)

  cache = { at: Date.now(), data: models }
  return { models, fetchedAt: cache.at }
}

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
  /** Whether the model accepts image input, from architecture.input_modalities (or modality fallback). */
  supportsImages: boolean
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
        architecture?: { modality?: string; input_modalities?: string[] }
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
      // Prefer the explicit input_modalities array; fall back to the legacy modality string.
      const inputModalities = Array.isArray(e.architecture?.input_modalities) ? e.architecture!.input_modalities : null
      const supportsImages = inputModalities
        ? inputModalities.includes("image")
        : e.architecture?.modality?.includes("image") ?? false
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
        supportsImages,
        createdAt: typeof e.created === "number" ? e.created : 0,
        rank: idx,
      }
      return info
    })
    .filter((x): x is OpenRouterModelInfo => x !== null)

  cache = { at: Date.now(), data: models }
  return { models, fetchedAt: cache.at }
}

// ---------------------------------------------------------------------------
// Per-model performance (latency / throughput) — only the basic /models list
// lacks these; they live on the per-model endpoints API. Fetched on demand for
// the handful of models in upgrade suggestions, cached separately.
// ---------------------------------------------------------------------------

export interface ModelPerf {
  /** p50 time-to-first-token in ms, from the fastest live endpoint. */
  latencyMs?: number
  /** p50 output throughput in tokens/sec, from that endpoint. */
  throughputTps?: number
}

const perfCache = new Map<string, { at: number; data: ModelPerf | null }>()

export async function fetchModelPerf(modelId: string): Promise<ModelPerf | null> {
  const cached = perfCache.get(modelId)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.data

  const headers: Record<string, string> = {}
  const key = getOpenRouterApiKey()
  if (key) headers.Authorization = `Bearer ${key}`

  try {
    const res = await fetch(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`, {
      headers,
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      perfCache.set(modelId, { at: Date.now(), data: null })
      return null
    }
    const body = (await res.json()) as {
      data?: { endpoints?: Array<{ latency_last_30m?: { p50?: number }; throughput_last_30m?: { p50?: number } }> }
    }
    const endpoints = body.data?.endpoints ?? []
    // Pick the endpoint with the lowest measured p50 latency — the best a
    // routed call could see. Ignore endpoints with no recent stats.
    let best: ModelPerf | null = null
    for (const e of endpoints) {
      const lat = e.latency_last_30m?.p50
      if (typeof lat !== "number") continue
      if (!best || lat < (best.latencyMs ?? Infinity)) {
        best = { latencyMs: lat, throughputTps: e.throughput_last_30m?.p50 }
      }
    }
    perfCache.set(modelId, { at: Date.now(), data: best })
    return best
  } catch {
    perfCache.set(modelId, { at: Date.now(), data: null })
    return null
  }
}

/**
 * Fetch the OpenRouter credit balance for the dashboard sidebar.
 *
 * Uses GET /api/v1/credits which returns the account's lifetime granted
 * credits and total usage; remaining = granted - used. Cached briefly so
 * the sidebar polling doesn't hammer OpenRouter.
 *
 * Returns null when no key is configured or the call fails — the sidebar
 * just hides the widget rather than showing an error.
 */
import { getOpenRouterApiKey } from "../config/openrouter.js"
import type { OpenRouterCredits } from "../../shared/api.js"

type Cache = { at: number; data: OpenRouterCredits | null }
let cache: Cache | null = null
const TTL_MS = 60_000

export async function fetchOpenRouterCredits(): Promise<OpenRouterCredits | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.data

  const key = getOpenRouterApiKey()
  if (!key) {
    cache = { at: Date.now(), data: null }
    return null
  }

  try {
    const res = await fetch("https://openrouter.ai/api/v1/credits", {
      headers: { Authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) {
      cache = { at: Date.now(), data: null }
      return null
    }
    const body = (await res.json()) as { data?: { total_credits?: number; total_usage?: number } }
    const granted = Number(body.data?.total_credits ?? 0)
    const used = Number(body.data?.total_usage ?? 0)
    if (!Number.isFinite(granted) || !Number.isFinite(used)) {
      cache = { at: Date.now(), data: null }
      return null
    }
    const data: OpenRouterCredits = {
      totalCredits: granted,
      totalUsage: used,
      remaining: Math.max(0, granted - used),
      fetchedAt: Date.now(),
    }
    cache = { at: Date.now(), data }
    return data
  } catch {
    cache = { at: Date.now(), data: null }
    return null
  }
}

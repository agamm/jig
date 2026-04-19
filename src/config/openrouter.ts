/**
 * Resolve the OpenRouter API key.
 *
 * Preferred: stored in the `credentials` table under ("openrouter", "api_key").
 * Fallback: process.env.OPENROUTER_API_KEY — kept so local dev with a `.env`
 * still works with zero dashboard setup. In service mode, the credentials
 * table is the only path.
 */
import { getCredential } from "../db.js"
import { LockedError } from "../crypto/password.js"

export const OPENROUTER_CREDENTIAL_KEY = "openrouter:api_key"

export function getOpenRouterApiKey(): string | null {
  try {
    const stored = getCredential(OPENROUTER_CREDENTIAL_KEY)
    if (stored) return stored
  } catch (e) {
    if (e instanceof LockedError) throw e
    // fall through to env fallback on other errors
  }
  const env = process.env.OPENROUTER_API_KEY
  return env && env.length > 0 ? env : null
}

export function requireOpenRouterApiKey(): string {
  const key = getOpenRouterApiKey()
  if (!key) {
    throw new Error(
      "OpenRouter API key not set. Add one in the dashboard (Settings → API Keys) or set OPENROUTER_API_KEY in .env for local development.",
    )
  }
  return key
}

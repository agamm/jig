/**
 * OpenRouter OAuth (PKCE).
 *
 * Why this exists: pasting an API key is the one piece of setup a user cannot
 * do wrong-but-recoverably. They paste the wrong key, or a key with no credit,
 * and every later failure looks like Jig being broken. OpenRouter's PKCE flow
 * hands us a user-owned key directly, so the only thing a user does is click
 * "authorize" in a browser they are already signed into.
 *
 * Two things differ from the MCP OAuth in `src/mcp/auth.ts`, which is why this
 * does not reuse it:
 *
 *   1. OpenRouter's flow has NO `state` parameter, so a code coming back cannot
 *      be routed by state the way `/api/oauth/callback` routes MCP codes. This
 *      gets its own callback path instead, and a single pending authorization.
 *   2. What comes back is not a token pair to refresh; it is a long-lived API
 *      key owned by the user, which we store exactly where a pasted one goes.
 */
import { createHash, randomBytes } from "node:crypto"
import { setCredential } from "../db.js"
import { OPENROUTER_CREDENTIAL_KEY } from "../config/openrouter.js"
import { invalidateOpenRouterCredits } from "./openrouter-credits.js"
import { isServiceMode, publicUrl } from "../config/runtime.js"

export const OPENROUTER_CALLBACK_PATH = "/api/openrouter/callback"

const AUTH_URL = "https://openrouter.ai/auth"
const EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys"

/** OpenRouter expires an authorization code after 10 minutes; match it. */
const PENDING_TTL_MS = 10 * 60_000

type Pending = { verifier: string; startedAt: number }

/**
 * One pending authorization at a time. There is one OpenRouter account per Jig
 * instance, so a second start is a retry of the first, not a parallel flow.
 */
let pending: Pending | null = null

function base64url(input: Buffer): string {
  return input.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

/** Where OpenRouter should send the user back to. Mirrors `oauthRedirectUrl()`. */
export function openRouterCallbackUrl(): string {
  if (isServiceMode()) {
    const base = publicUrl()
    if (!base) throw new Error("This instance has no public URL, so OpenRouter cannot redirect back to it.")
    return `${base}${OPENROUTER_CALLBACK_PATH}`
  }
  const apiPort = process.env.JIG_API_PORT || "4173"
  return `http://localhost:${apiPort}${OPENROUTER_CALLBACK_PATH}`
}

/**
 * Stage a PKCE authorization. Returns the URL to open in a browser; the key
 * arrives later, at the callback.
 */
export function startOpenRouterOAuth(): { authorizationUrl: string; callbackUrl: string } {
  const verifier = base64url(randomBytes(32))
  const challenge = base64url(createHash("sha256").update(verifier).digest())
  pending = { verifier, startedAt: Date.now() }

  const callbackUrl = openRouterCallbackUrl()
  const params = new URLSearchParams({
    callback_url: callbackUrl,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })
  return { authorizationUrl: `${AUTH_URL}?${params}`, callbackUrl }
}

/**
 * Exchange the code for a user-owned API key and store it.
 *
 * The verifier never leaves this process, which is what makes the code useless
 * to anyone who intercepts the redirect.
 */
export async function completeOpenRouterOAuth(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const staged = pending
  pending = null
  if (!staged) return { ok: false, error: "No OpenRouter authorization is in flight. Start setup again." }
  if (Date.now() - staged.startedAt > PENDING_TTL_MS) {
    return { ok: false, error: "That authorization expired. Start setup again." }
  }

  let res: Response
  try {
    res = await fetch(EXCHANGE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code, code_verifier: staged.verifier, code_challenge_method: "S256" }),
      signal: AbortSignal.timeout(15_000),
    })
  } catch (e: any) {
    return { ok: false, error: `Could not reach OpenRouter to exchange the code: ${e?.message ?? e}` }
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    return { ok: false, error: `OpenRouter rejected the exchange (HTTP ${res.status})${body ? `: ${body.slice(0, 200)}` : ""}` }
  }

  const body = (await res.json().catch(() => ({}))) as { key?: unknown }
  const key = typeof body.key === "string" ? body.key.trim() : ""
  if (!key) return { ok: false, error: "OpenRouter returned no key for that code." }

  setCredential(OPENROUTER_CREDENTIAL_KEY, key, "openrouter")
  // The balance is cached for 60s. Without this, the setup wizard's very next
  // poll reads the pre-key null and reports a good key as missing.
  invalidateOpenRouterCredits()
  return { ok: true }
}

/** Test seam: drop any staged authorization. */
export function resetOpenRouterOAuth(): void {
  pending = null
}

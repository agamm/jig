/**
 * Classify whether a failed tool-call error means the underlying connection
 * needs (re-)authentication — so the dashboard can offer a Reconnect action.
 *
 * Uses the LLM (not brittle keyword matching) so arbitrary phrasings from any
 * MCP server are understood. Cached by error text so a repeated/identical
 * failure is classified once.
 */
import { fastYesNo } from "../config/fast-llm.js"

const SYSTEM_PROMPT =
  "You classify automation errors. Decide if an error means the connection/integration " +
  "needs the user to (re-)authenticate or reconnect — e.g. expired/revoked/missing credentials, " +
  'OAuth or login required, session expired, 401/403 unauthorized, "no browser available". ' +
  "It is NOT a reconnect case if the error is a bad request, rate limit, not-found, timeout, " +
  "network blip, or a logic/validation error. " +
  "Exception: when the report says saved credentials that previously worked were used and the " +
  "failure happened while (re)connecting, treat a bare 4xx status with no validation detail " +
  "(e.g. 400 or 405 with no field errors) as a reconnect case — some providers answer expired " +
  "or revoked tokens with a non-401 status at connect time. " +
  "Reply with exactly one word: yes or no."

type CacheEntry = { at: number; needsReauth: boolean }
const cache = new Map<string, CacheEntry>()
const TTL_MS = 60 * 60 * 1000
const MAX_INPUT = 2000

export async function classifyAuthFailure(errorText: string): Promise<boolean> {
  const key = errorText.trim().slice(0, MAX_INPUT)
  if (!key) return false

  const cached = cache.get(key)
  if (cached && Date.now() - cached.at < TTL_MS) return cached.needsReauth

  const needsReauth = await fastYesNo(SYSTEM_PROMPT, `Error:\n${key}`)
  cache.set(key, { at: Date.now(), needsReauth })
  return needsReauth
}

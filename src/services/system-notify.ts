/**
 * System notifications — out-of-band alerts about the engine itself
 * (broken MCP connections, expired tokens, scheduler trouble).
 *
 * Deliberately does NOT route through MCP notification tools: when the thing
 * that broke IS an MCP connection, a notification that depends on MCP can't be
 * delivered. AgentMail is a single HTTPS call with an API key — the only moving
 * parts are the network and the credentials table.
 *
 * Invariants:
 *   - notifySystem() never throws; callers fire-and-forget.
 *   - Debounced per dedupe key (default 6h) via the settings table, so a
 *     flapping connection doesn't flood the inbox and the debounce survives
 *     process restarts.
 */
import { getSetting, setSetting } from "../db.js"
import { logSessionEvent } from "../debug/session-log.js"
import { canSendAgentMail, getAgentMailSettings, sendAgentMailEmail } from "./agentmail.js"

const DEBOUNCE_SETTING_PREFIX = "system_notify.sent."
const DEFAULT_DEBOUNCE_MS = 6 * 60 * 60 * 1000

/**
 * Fire a system alert (email via AgentMail). Debounced per dedupeKey so repeat
 * failures of the same component don't spam. Never throws.
 */
export async function notifySystem(opts: {
  source: string
  title: string
  body: string
  /** Defaults to `source`. Alerts sharing a key are debounced together. */
  dedupeKey?: string
  debounceMs?: number
}): Promise<boolean> {
  const dedupeKey = opts.dedupeKey ?? opts.source
  const debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS
  try {
    const owner = getAgentMailSettings().owner
    if (!canSendAgentMail() || !owner) return false

    const settingKey = `${DEBOUNCE_SETTING_PREFIX}${dedupeKey}`
    const lastSentAt = getSetting<number>(settingKey)
    if (typeof lastSentAt === "number" && Date.now() - lastSentAt < debounceMs) return false
    // Stamp before sending — a hard-failing send shouldn't retry on every
    // subsequent event either.
    setSetting(settingKey, Date.now())

    await sendAgentMailEmail({ to: owner, subject: opts.title, text: opts.body })
    logSessionEvent({ source: "notify.system", event: "sent", origin: opts.source, dedupeKey, title: opts.title })
    return true
  } catch (error) {
    logSessionEvent({ source: "notify.system", event: "error", origin: opts.source, dedupeKey, error })
    return false
  }
}

/**
 * System notifications — out-of-band alerts about the engine itself
 * (broken MCP connections, expired tokens, scheduler trouble).
 *
 * Deliberately does NOT route through MCP notification tools: when the thing
 * that broke IS an MCP connection, a notification that depends on MCP can't
 * be delivered. Resend is a single HTTPS call with an API key — the only
 * moving parts are the network and the credentials table.
 *
 * Invariants:
 *   - notifySystem() never throws; callers fire-and-forget.
 *   - Debounced per dedupe key (default 6h) via the settings table, so a
 *     flapping connection doesn't flood the inbox and the debounce survives
 *     process restarts.
 */
import { getCredential, getSetting, setCredential, setSetting } from "../db.js"
import { logSessionEvent } from "../debug/session-log.js"
import type { ResendSettingsResponse } from "../../shared/api.js"

const RESEND_KEY_CREDENTIAL = "resend:api_key"
const RESEND_SETTINGS_KEY = "resend"
const DEBOUNCE_SETTING_PREFIX = "system_notify.sent."
const DEFAULT_DEBOUNCE_MS = 6 * 60 * 60 * 1000

// Resend's shared onboarding sender — works without domain verification but
// only delivers to the account owner's own address. Good enough as a default;
// users with a verified domain can override.
const DEFAULT_FROM = "Jig <onboarding@resend.dev>"

export interface ResendSettings {
  to: string | null
  from: string | null
}

export function getResendSettings(): ResendSettings {
  const raw = getSetting<Partial<ResendSettings>>(RESEND_SETTINGS_KEY)
  return {
    to: typeof raw?.to === "string" && raw.to.trim() ? raw.to.trim() : null,
    from: typeof raw?.from === "string" && raw.from.trim() ? raw.from.trim() : null,
  }
}

function getResendApiKey(): string | null {
  // getCredential throws LockedError in service mode before unlock — treat
  // that as "not available right now" rather than crashing the notifier.
  try {
    return getCredential(RESEND_KEY_CREDENTIAL)
  } catch {
    return null
  }
}

export function isResendConfigured(): boolean {
  return getResendApiKey() != null && getResendSettings().to != null
}

/** Dashboard-facing status — never exposes the API key itself. */
export function getResendStatus(): ResendSettingsResponse {
  const settings = getResendSettings()
  const hasKey = getResendApiKey() != null
  return {
    configured: hasKey && settings.to != null,
    hasKey,
    to: settings.to,
    from: settings.from,
  }
}

export function saveResendSettings(input: { apiKey?: string; to?: string; from?: string }): void {
  if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    setCredential(RESEND_KEY_CREDENTIAL, input.apiKey.trim(), "resend")
  }
  const current = getResendSettings()
  setSetting(RESEND_SETTINGS_KEY, {
    to: typeof input.to === "string" ? (input.to.trim() || null) : current.to,
    from: typeof input.from === "string" ? (input.from.trim() || null) : current.from,
  })
}

/** Send a plain-text email via Resend. Throws on HTTP/config errors. */
export async function sendResendEmail(opts: { subject: string; text: string }): Promise<void> {
  const apiKey = getResendApiKey()
  const settings = getResendSettings()
  if (!apiKey) throw new Error("Resend API key is not configured")
  if (!settings.to) throw new Error("Resend recipient email is not configured")

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: settings.from ?? DEFAULT_FROM,
      to: [settings.to],
      subject: opts.subject,
      text: opts.text,
    }),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Resend API error ${res.status}: ${body.slice(0, 300)}`)
  }
}

/**
 * Fire a system alert (email via Resend). Debounced per dedupeKey so repeat
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
    if (!isResendConfigured()) return false

    const settingKey = `${DEBOUNCE_SETTING_PREFIX}${dedupeKey}`
    const lastSentAt = getSetting<number>(settingKey)
    if (typeof lastSentAt === "number" && Date.now() - lastSentAt < debounceMs) return false
    // Stamp before sending — a hard-failing Resend call shouldn't retry on
    // every subsequent event either.
    setSetting(settingKey, Date.now())

    await sendResendEmail({ subject: opts.title, text: opts.body })
    logSessionEvent({ source: "notify.system", event: "sent", origin: opts.source, dedupeKey, title: opts.title })
    return true
  } catch (error) {
    logSessionEvent({ source: "notify.system", event: "error", origin: opts.source, dedupeKey, error })
    return false
  }
}

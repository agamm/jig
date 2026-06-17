/**
 * AgentMail — repliable jig-failure emails.
 *
 * Jig-failure notifications are sent from an AgentMail inbox (a free
 * `@agentmail.to` address, no DNS setup). Because that inbox can *receive*
 * mail, the user can reply to a failure email in plain English and Jig routes
 * the reply to the jig's authoring agent (see email-inbound.ts). AgentMail
 * delivers inbound replies to our webhook and handles SPF/DKIM/DMARC itself,
 * classifying authenticated mail as `message.received` and everything else as
 * `.spam`/`.blocked`/`.unauthenticated`.
 *
 * Raw `fetch` only — no SDK — matching how Resend is used in system-notify.ts.
 * Inbox + webhook creation are idempotent via a fixed `client_id`, so setup is
 * safe to re-run.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import { getCredential, getSetting, setCredential, setSetting } from "../db.js"
import type { AgentMailSettingsResponse } from "../../shared/api.js"

const API_BASE = "https://api.agentmail.to/v0"
const API_KEY_CREDENTIAL = "agentmail:api_key"
const WEBHOOK_SECRET_CREDENTIAL = "agentmail:webhook_secret"
const SETTINGS_KEY = "agentmail"
// Fixed client_id makes create-inbox / create-webhook idempotent: AgentMail
// returns the existing resource instead of provisioning a duplicate.
const CLIENT_ID = "jig"
// Reject webhook calls whose timestamp is too old (replay protection).
const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000

export interface AgentMailSettings {
  inboxId: string | null
  address: string | null
  owner: string | null
}

export function getAgentMailSettings(): AgentMailSettings {
  const raw = getSetting<Partial<AgentMailSettings>>(SETTINGS_KEY)
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  return {
    inboxId: str(raw?.inboxId),
    address: str(raw?.address),
    owner: str(raw?.owner),
  }
}

function getApiKey(): string | null {
  // getCredential throws LockedError in service mode before unlock — treat that
  // as "not available right now" rather than crashing the caller.
  try {
    return getCredential(API_KEY_CREDENTIAL)
  } catch {
    return null
  }
}

function getWebhookSecret(): string | null {
  try {
    return getCredential(WEBHOOK_SECRET_CREDENTIAL)
  } catch {
    return null
  }
}

/** Fully wired: key + provisioned inbox + registered webhook + a known owner. */
export function isAgentMailConfigured(): boolean {
  const s = getAgentMailSettings()
  return getApiKey() != null && s.inboxId != null && s.owner != null && getWebhookSecret() != null
}

/** Dashboard-facing status — never exposes the API key or signing secret. */
export function getAgentMailStatus(): AgentMailSettingsResponse {
  const s = getAgentMailSettings()
  const hasKey = getApiKey() != null
  const webhookReady = getWebhookSecret() != null
  return {
    configured: hasKey && s.inboxId != null && s.owner != null && webhookReady,
    hasKey,
    address: s.address,
    owner: s.owner,
    webhookReady,
  }
}

export function saveAgentMailSettings(input: { apiKey?: string; owner?: string }): void {
  if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    setCredential(API_KEY_CREDENTIAL, input.apiKey.trim(), "agentmail")
  }
  const current = getAgentMailSettings()
  setSetting(SETTINGS_KEY, {
    ...current,
    owner: typeof input.owner === "string" ? (input.owner.trim() || null) : current.owner,
  })
}

// ---------------------------------------------------------------------------
// API calls (raw fetch)
// ---------------------------------------------------------------------------

async function apiFetch(path: string, body: unknown): Promise<any> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error("AgentMail API key is not configured")
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`AgentMail API error ${res.status}: ${text.slice(0, 300)}`)
  }
  return res.json()
}

/** Create (or fetch existing, via client_id) the Jig inbox. */
async function createInbox(): Promise<{ inboxId: string; address: string }> {
  const data = await apiFetch("/inboxes", { client_id: CLIENT_ID, display_name: "Jig" })
  return { inboxId: data.inbox_id, address: data.email }
}

/** Register (or fetch existing) the inbound webhook. Returns the signing secret. */
async function registerWebhook(url: string): Promise<string> {
  const data = await apiFetch("/webhooks", {
    url,
    event_types: ["message.received"],
    client_id: CLIENT_ID,
  })
  if (!data.secret) throw new Error("AgentMail did not return a webhook signing secret")
  return data.secret as string
}

/**
 * Idempotent setup: provision the inbox + inbound webhook and persist the
 * inbox id, address, and webhook signing secret. Returns the inbox address.
 */
export async function setupAgentMail(webhookUrl: string): Promise<string> {
  const { inboxId, address } = await createInbox()
  const secret = await registerWebhook(webhookUrl)
  setCredential(WEBHOOK_SECRET_CREDENTIAL, secret, "agentmail")
  const current = getAgentMailSettings()
  setSetting(SETTINGS_KEY, { ...current, inboxId, address })
  return address
}

/** Send a plain-text email from the Jig inbox. Returns thread + message ids. */
export async function sendAgentMailEmail(opts: {
  to: string
  subject: string
  text: string
}): Promise<{ threadId: string; messageId: string }> {
  const { inboxId } = getAgentMailSettings()
  if (!inboxId) throw new Error("AgentMail inbox is not provisioned")
  const data = await apiFetch(`/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
    to: [opts.to],
    subject: opts.subject,
    text: opts.text,
  })
  return { threadId: data.thread_id, messageId: data.message_id }
}

/** Reply to an inbound message — AgentMail keeps it in the same thread. */
export async function replyAgentMail(opts: { messageId: string; text: string }): Promise<void> {
  const { inboxId } = getAgentMailSettings()
  if (!inboxId) throw new Error("AgentMail inbox is not provisioned")
  await apiFetch(
    `/inboxes/${encodeURIComponent(inboxId)}/messages/${encodeURIComponent(opts.messageId)}/reply`,
    { text: opts.text },
  )
}

// ---------------------------------------------------------------------------
// Webhook signature verification (Svix scheme, inline — no svix dependency)
// ---------------------------------------------------------------------------

/**
 * Verify an AgentMail (Svix) webhook signature over the *raw* request body.
 * Signature is HMAC-SHA256 of `${svix-id}.${svix-timestamp}.${rawBody}` keyed by
 * the base64-decoded secret (minus its `whsec_` prefix). The `svix-signature`
 * header is a space-delimited list of `v1,<base64>` entries; any match passes.
 */
export function verifyAgentMailWebhook(rawBody: string, headers: Headers): boolean {
  const secret = getWebhookSecret()
  if (!secret) return false

  const id = headers.get("svix-id")
  const timestamp = headers.get("svix-timestamp")
  const signature = headers.get("svix-signature")
  if (!id || !timestamp || !signature) return false

  // Replay protection: reject timestamps outside the tolerance window.
  const tsSeconds = Number(timestamp)
  if (!Number.isFinite(tsSeconds)) return false
  if (Math.abs(Date.now() - tsSeconds * 1000) > WEBHOOK_TOLERANCE_MS) return false

  const secretBytes = Buffer.from(secret.replace(/^whsec_/, ""), "base64")
  const expected = createHmac("sha256", secretBytes)
    .update(`${id}.${timestamp}.${rawBody}`)
    .digest()

  // Header may carry multiple space-delimited `v1,<sig>` signatures.
  for (const part of signature.split(" ")) {
    const [version, value] = part.split(",")
    if (version !== "v1" || !value) continue
    const provided = Buffer.from(value, "base64")
    if (provided.length === expected.length && timingSafeEqual(provided, expected)) return true
  }
  return false
}

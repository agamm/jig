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
 * Raw `fetch` only — no SDK — to keep dependencies and moving parts minimal.
 * Inbox + webhook creation are idempotent via a fixed `client_id`, so setup is
 * safe to re-run.
 */
import { createHmac, timingSafeEqual } from "node:crypto"
import { getCredential, getSetting, setCredential, setSetting } from "../db.js"
import { publicUrl } from "../config/runtime.js"
import { logSessionEvent } from "../debug/session-log.js"
import { collapseHtmlTagWhitespace } from "../text.js"
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
  /** The URL the inbound webhook was registered with. Replies go there, wherever this instance now lives. */
  webhookUrl: string | null
  /** Email the owner when a jig run fails. Alerting's only on/off switch. */
  notifyOnFailure: boolean
}

export function getAgentMailSettings(): AgentMailSettings {
  const raw = getSetting<Partial<AgentMailSettings>>(SETTINGS_KEY)
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null)
  return {
    inboxId: str(raw?.inboxId),
    address: str(raw?.address),
    owner: str(raw?.owner),
    webhookUrl: str(raw?.webhookUrl),
    notifyOnFailure: typeof raw?.notifyOnFailure === "boolean" ? raw.notifyOnFailure : true,
  }
}

/** Where this instance's inbound webhook must point; null when there is no public URL (local). */
export function expectedWebhookUrl(): string | null {
  const base = publicUrl()
  return base ? `${base}/api/email/inbound` : null
}

/**
 * The registered webhook points somewhere else. The shape a restored backup
 * produces: settings and secret from the old instance, a new URL here, and
 * AgentMail still posting the owner's replies to the old one. Unknown (no URL
 * stored by an older version, or no public URL) is not a mismatch.
 */
export function webhookMismatch(): boolean {
  const expected = expectedWebhookUrl()
  const stored = getAgentMailSettings().webhookUrl
  return expected != null && stored != null && stored !== expected
}

function getApiKey(): string | null {
  // getCredential throws LockedError while a hosted instance is locked; no
  // mail can go out until it is unlocked (JIG_DATA_KEY makes that automatic).
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

/**
 * Can send outbound mail (failure + system alerts). Needs only key + inbox +
 * owner — NOT the inbound webhook. So alerting works even on a host with no
 * public URL, where reply-to-edit can't.
 */
export function canSendAgentMail(): boolean {
  const s = getAgentMailSettings()
  return getApiKey() != null && s.inboxId != null && s.owner != null
}

/** Fully wired for reply-to-edit: can send AND the inbound webhook is registered and points here. */
export function isAgentMailConfigured(): boolean {
  return canSendAgentMail() && getWebhookSecret() != null && !webhookMismatch()
}

/** Dashboard-facing status — never exposes the API key or signing secret. */
export function getAgentMailStatus(): AgentMailSettingsResponse {
  const s = getAgentMailSettings()
  const mismatch = webhookMismatch()
  return {
    configured: isAgentMailConfigured(),
    canSend: canSendAgentMail(),
    hasKey: getApiKey() != null,
    address: s.address,
    owner: s.owner,
    webhookReady: getWebhookSecret() != null && !mismatch,
    webhookUrl: s.webhookUrl,
    webhookMismatch: mismatch,
    notifyOnFailure: s.notifyOnFailure,
  }
}

export function saveAgentMailSettings(input: { apiKey?: string; owner?: string; notifyOnFailure?: boolean }): void {
  if (typeof input.apiKey === "string" && input.apiKey.trim()) {
    setCredential(API_KEY_CREDENTIAL, input.apiKey.trim(), "agentmail")
  }
  const current = getAgentMailSettings()
  setSetting(SETTINGS_KEY, {
    ...current,
    owner: typeof input.owner === "string" ? (input.owner.trim() || null) : current.owner,
    notifyOnFailure: typeof input.notifyOnFailure === "boolean" ? input.notifyOnFailure : current.notifyOnFailure,
  })
}

// ---------------------------------------------------------------------------
// API calls (raw fetch)
// ---------------------------------------------------------------------------

async function apiFetch(path: string, body?: unknown, method: "POST" | "GET" | "DELETE" = "POST"): Promise<any> {
  const apiKey = getApiKey()
  if (!apiKey) throw new Error("AgentMail API key is not configured")
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${apiKey}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(15_000),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`AgentMail API error ${res.status}: ${text.slice(0, 300)}`)
  }
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

/** Create (or fetch existing, via client_id) the Jig inbox. */
async function createInbox(): Promise<{ inboxId: string; address: string }> {
  const data = await apiFetch("/inboxes", { client_id: CLIENT_ID, display_name: "Jig" })
  return { inboxId: data.inbox_id, address: data.email }
}

/**
 * The inbox an email-triggered jig receives on.
 *
 * A jig gets its own address rather than a share of the main one because that
 * address is the routing key: inbound mail is matched on `message.inbox_id`, so
 * "mail for the to-do jig" and "a reply about a broken jig" stay separable
 * without asking the user to format a subject line. (AgentMail documents no
 * plus-addressing, so a single inbox could not carry the distinction.)
 *
 * The existing webhook is registered org-wide, no `inbox_ids` filter, so a new
 * inbox needs no webhook change. That is also why we do NOT scope webhooks per
 * inbox: `inbox_ids` caps at 10 per webhook, which would break at 11 email jigs.
 *
 * `client_id` makes this idempotent, so a re-sync returns the existing inbox
 * rather than provisioning a second one.
 */
export async function createJigInbox(jigId: string): Promise<{ inboxId: string; address: string }> {
  const clientId = `${CLIENT_ID}:${jigId}`
  // agentmail.to is shared across every AgentMail customer, so a plain "todo"
  // is long gone. Suffix with a hash of the jig id: stable for a given jig
  // (a retry lands on the same name) without colliding across instances.
  const suffix = inboxSuffix(jigId)
  // Truncate the BASE, never the combined string. Slicing after joining can cut
  // the suffix off entirely (so two long jig ids sharing a prefix would request
  // the same username) or land on the separator, leaving a trailing "-" that
  // AgentMail rejects with a validation error the fallback below cannot match.
  const base = sanitizeUsername(jigId).slice(0, 40).replace(/-+$/, "") || "jig"
  const preferred = `${base}-${suffix}`

  for (const body of [
    { client_id: clientId, username: preferred, display_name: `Jig: ${jigId}` },
    // Username taken by another org: let AgentMail generate one. A less pretty
    // address still routes correctly, and failing setup over cosmetics would
    // leave the jig with no way to receive mail at all.
    { client_id: clientId, display_name: `Jig: ${jigId}` },
  ]) {
    try {
      const data = await apiFetch("/inboxes", body)
      return { inboxId: data.inbox_id, address: data.email }
    } catch (error) {
      const message = (error as Error)?.message ?? ""
      if (!/resource_taken|already in use/i.test(message)) throw error
      console.warn(`[agentmail] inbox username "${preferred}" is taken; falling back to a generated one`)
    }
  }
  throw new Error(`Could not provision an inbox for ${jigId}`)
}

/** Lowercase alphanumerics and dashes only, the subset every mail host accepts. */
function sanitizeUsername(jigId: string): string {
  const cleaned = jigId.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "jig"
}

function inboxSuffix(jigId: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(`inbox:${jigId}`)
  return hasher.digest("hex").slice(0, 6)
}

/**
 * Register the inbound webhook at `url`. Creation is idempotent by client_id,
 * so an existing registration is returned as it is, URL included: a webhook
 * made by the instance a backup came from would keep receiving the owner's
 * replies. AgentMail cannot change a webhook's URL, so one that points
 * elsewhere is deleted and registered afresh. Returns the signing secret.
 */
async function registerWebhook(url: string): Promise<string> {
  const listed = (await apiFetch("/webhooks", undefined, "GET")) as { webhooks?: { webhook_id: string; url: string; client_id?: string }[] } | null
  const ours = listed?.webhooks?.find((w) => w.client_id === CLIENT_ID)
  if (ours && ours.url !== url) {
    await apiFetch(`/webhooks/${encodeURIComponent(ours.webhook_id)}`, undefined, "DELETE")
    console.log(`[agentmail] moved the reply-to-edit webhook from ${ours.url} to ${url}`)
  }
  const data = await apiFetch("/webhooks", {
    url,
    event_types: ["message.received"],
    client_id: CLIENT_ID,
  })
  if (!data?.secret) throw new Error("AgentMail did not return a webhook signing secret")
  return data.secret as string
}

/**
 * Idempotent setup. Provisions the inbox and persists it FIRST — that alone
 * makes alerting work (send-only). The inbound webhook (which enables
 * reply-to-edit) is then attempted best-effort: if no public URL is available
 * (e.g. localhost) or registration fails, the inbox still sends alerts and the
 * webhook can be added later by re-running setup once a URL exists.
 */
export async function setupAgentMail(
  webhookUrl: string | null,
): Promise<{ address: string; webhookReady: boolean }> {
  const { inboxId, address } = await createInbox()
  const current = getAgentMailSettings()
  setSetting(SETTINGS_KEY, { ...current, inboxId, address })

  let webhookReady = false
  if (webhookUrl) {
    try {
      const secret = await registerWebhook(webhookUrl)
      setCredential(WEBHOOK_SECRET_CREDENTIAL, secret, "agentmail")
      setSetting(SETTINGS_KEY, { ...getAgentMailSettings(), webhookUrl })
      webhookReady = true
    } catch (e) {
      // Inbox is usable for alerts; reply-to-edit just isn't wired up yet.
      console.warn(`[agentmail] inbox created but webhook registration failed: ${(e as Error)?.message ?? e}`)
    }
  }
  return { address, webhookReady }
}

/**
 * Send an email from the Jig inbox (plain text and/or HTML). Returns thread +
 * message ids.
 *
 * `fromInboxId` overrides the sending inbox. An email-triggered jig sends from
 * its OWN inbox so that a reply lands back there and is routed to the jig as
 * data, replies to the main inbox mean "edit this jig" instead.
 */
export async function sendAgentMailEmail(opts: {
  to: string
  subject: string
  text?: string
  html?: string
  fromInboxId?: string
}): Promise<{ threadId: string; messageId: string }> {
  const inboxId = opts.fromInboxId ?? getAgentMailSettings().inboxId
  if (!inboxId) throw new Error("AgentMail inbox is not provisioned")
  const data = await apiFetch(`/inboxes/${encodeURIComponent(inboxId)}/messages/send`, {
    to: [opts.to],
    subject: opts.subject,
    ...(opts.text != null && { text: opts.text }),
    // Newlines between tags arrive as stray <br>s, so flatten them here rather
    // than asking every jig to emit its html on one line. See src/text.ts.
    ...(opts.html != null && { html: collapseHtmlTagWhitespace(opts.html) }),
  })
  // Every outbound email in one greppable place — duplicate-send questions
  // ("why did I get this twice?") are unanswerable without it. Subject only;
  // bodies stay out of the log.
  logSessionEvent({
    source: "email.send",
    event: "sent",
    to: opts.to,
    subject: opts.subject,
    threadId: data.thread_id,
    messageId: data.message_id,
  })
  return { threadId: data.thread_id, messageId: data.message_id }
}

/** Reply to an inbound message, AgentMail keeps it in the same thread. The
 *  reply must go out from the inbox that RECEIVED it, so `fromInboxId` is
 *  required whenever the message arrived in a jig's own inbox. */
export async function replyAgentMail(opts: { messageId: string; text: string; fromInboxId?: string }): Promise<void> {
  const inboxId = opts.fromInboxId ?? getAgentMailSettings().inboxId
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

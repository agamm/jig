/**
 * Per-thread reply token — the missing authorization factor for reply-to-edit.
 *
 * Inbound replies are otherwise authorized only by the `From` header matching
 * the owner, which SMTP makes trivially spoofable (the Svix signature only
 * proves AgentMail delivered the webhook, not who authored the mail). This token
 * is a shared secret we place in BOTH the outbound subject and a body footer and
 * store on the thread. A genuine reply — sent by whoever actually received our
 * email — echoes the token (subject line, or the quoted body). An attacker who
 * spoofs `From` but never saw the email cannot produce it, so the reply is
 * rejected. We check subject AND raw body because email clients vary in what
 * they preserve, and AgentMail's inbound payload may omit the subject.
 */
import { randomBytes } from "node:crypto"

// Unambiguous uppercase alphabet (no I/L/O/U/0/1) so the token survives being
// read off a subject line and retyped. 10 chars ≈ 49 bits — unguessable over an
// email channel where each attempt must clear AgentMail's inbound filtering.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTVWXYZ"
const TOKEN_LEN = 10

export function mintReplyToken(): string {
  const bytes = randomBytes(TOKEN_LEN)
  let out = ""
  for (let i = 0; i < TOKEN_LEN; i++) out += ALPHABET[bytes[i] % ALPHABET.length]
  return out
}

/** Tag an outbound subject with the token: `"<subject> [#TOKEN]"`. */
export function subjectWithReplyToken(subject: string, token: string): string {
  return `${subject} [#${token}]`
}

/** A footer line carrying the token, appended to the outbound body so the token
 *  still round-trips when a reply quotes the body but the payload omits the subject. */
export function replyTokenFooter(token: string): string {
  return `\n\n— reply ref #${token} · keep this line so I can verify the reply is yours`
}

/** HTML variant of {@link replyTokenFooter} for html-bodied mail. */
export function replyTokenHtmlFooter(token: string): string {
  return `<p style="color:#888;font-size:12px;margin-top:16px">— reply ref #${token} · keep this line so I can verify the reply is yours</p>`
}

/** True if the inbound reply echoes the thread's token in the subject or body. */
export function replyCarriesToken(
  token: string,
  parts: { subject?: string | null; text?: string | null },
): boolean {
  if (!token) return false
  const hay = `${parts.subject ?? ""}\n${parts.text ?? ""}`.toUpperCase()
  return hay.includes(token.toUpperCase())
}

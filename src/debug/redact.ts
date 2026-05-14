/**
 * Redaction for log payloads. Two passes:
 *
 *   1. Field-name redaction — any object key matching SENSITIVE_KEY_RE is
 *      replaced with "[REDACTED]". Catches the common cases:
 *      apiKey, authorization header, access_token, client_secret, password.
 *
 *   2. Value-shape redaction — string values matching well-known credential
 *      patterns (Bearer …, sk-…, ghp_…, AKIA…, JWT) are also replaced. This
 *      catches secrets embedded inside otherwise-innocent fields like the
 *      stringified body of an HTTP request.
 *
 * Long strings are truncated so single LLM payloads can't fill the log
 * buffer. Truncation happens AFTER redaction so we never half-redact a token.
 */
const SENSITIVE_KEY_RE = /password|secret|token|api[_-]?key|authorization|cookie|credential|bearer/i

const TOKEN_VALUE_RE =
  /(Bearer\s+[A-Za-z0-9._\-+/=]{8,})|(sk-[A-Za-z0-9_\-]{20,})|(gh[opusr]_[A-Za-z0-9]{20,})|(AKIA[A-Z0-9]{16})|(eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,})/g

const MAX_STRING_LEN = 4096
const TRUNC_KEEP = 2048
const REDACTED = "[REDACTED]"

export function redact(value: unknown): unknown {
  return redactInner(value, new WeakSet())
}

function redactInner(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === "bigint") return value.toString()
  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactString(value.message ?? ""),
      stack: redactString(value.stack ?? ""),
    }
  }
  if (typeof value === "string") return redactString(value)
  if (typeof value !== "object") return value

  if (seen.has(value as object)) return "[Circular]"
  seen.add(value as object)

  if (Array.isArray(value)) {
    return value.map((v) => redactInner(v, seen))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redactInner(v, seen)
  }
  return out
}

function redactString(s: string): string {
  // Reset regex state — TOKEN_VALUE_RE has the /g flag.
  TOKEN_VALUE_RE.lastIndex = 0
  let cleaned = s.replace(TOKEN_VALUE_RE, REDACTED)
  if (cleaned.length > MAX_STRING_LEN) {
    cleaned = `${cleaned.slice(0, TRUNC_KEEP)}…[+${cleaned.length - TRUNC_KEEP} chars truncated]`
  }
  return cleaned
}

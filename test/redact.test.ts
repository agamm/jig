import { describe, expect, it } from "bun:test"
import { redact } from "../src/debug/redact.js"

describe("redact", () => {
  // The `token` substring in SENSITIVE_KEY_RE used to swallow every usage
  // field, so a log showed a call's dollar cost but not the token counts that
  // explain it — the exact numbers needed to diagnose a context blowup.
  it("keeps LLM token counts readable", () => {
    const out = redact({
      usage: {
        prompt_tokens: 1523,
        completion_tokens: 88,
        total_tokens: 1611,
        cost: 0.0005638,
        prompt_tokens_details: { cached_tokens: 1024 },
      },
    }) as any
    expect(out.usage.prompt_tokens).toBe(1523)
    expect(out.usage.completion_tokens).toBe(88)
    expect(out.usage.total_tokens).toBe(1611)
    expect(out.usage.prompt_tokens_details.cached_tokens).toBe(1024)
  })

  it("still redacts real credential keys", () => {
    const out = redact({
      access_token: "abc123",
      refresh_token: "def456",
      api_key: "xyz",
      password: "hunter2",
      authorization: "Bearer nope",
    }) as any
    for (const k of ["access_token", "refresh_token", "api_key", "password", "authorization"]) {
      expect(out[k]).toBe("[REDACTED]")
    }
  })

  it("still redacts credential-shaped values under an exempt key", () => {
    const out = redact({ tokens: ["sk-abcdefghijklmnopqrstuvwxyz012345"] }) as any
    expect(out.tokens[0]).toBe("[REDACTED]")
  })
})

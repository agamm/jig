/**
 * The shared one-shot OpenRouter helper.
 *
 * Its contract is mostly about FAILURE: every caller (auth-failure
 * classification, reply-approval classification, change summaries, trigger
 * parsing, web search) is best-effort and must degrade rather than throw. The
 * approval classifier in particular must fail CLOSED — an unreachable model
 * must never be read as "yes, ship the fix".
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, openDb, setCredential } from "../src/db.js"
import { fastCompletion, fastCompletionMessage, fastYesNo } from "../src/config/fast-llm.js"

const realFetch = globalThis.fetch
let requests: { url: string; body: any }[] = []

function stubFetch(handler: (body: any) => Response | Promise<Response>) {
  globalThis.fetch = (async (input: any, init?: any) => {
    const body = init?.body ? JSON.parse(init.body) : {}
    requests.push({ url: String(input), body })
    return handler(body)
  }) as typeof fetch
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } })
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  requests = []
  // getOpenRouterApiKey prefers the credentials table over the env fallback.
  setCredential("openrouter:api_key", "test-key", "openrouter")
})

afterEach(() => {
  globalThis.fetch = realFetch
  closeDb()
})

describe("fastCompletion", () => {
  it("returns the assistant's trimmed text", async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: "  hello  " } }] }))
    expect(await fastCompletion({ system: "s", user: "u", maxTokens: 10 })).toBe("hello")
  })

  it("sends the system and user messages with a bounded token budget", async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }))
    await fastCompletion({ system: "SYS", user: "USR", maxTokens: 42 })

    expect(requests).toHaveLength(1)
    expect(requests[0].url).toBe("https://openrouter.ai/api/v1/chat/completions")
    expect(requests[0].body.max_tokens).toBe(42)
    expect(requests[0].body.temperature).toBe(0)
    expect(requests[0].body.messages).toEqual([
      { role: "system", content: "SYS" },
      { role: "user", content: "USR" },
    ])
  })

  it("merges extra body fields, which is how web search enables its plugin", async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: "ok" } }] }))
    await fastCompletion({ system: "s", user: "u", maxTokens: 10, body: { plugins: [{ id: "web" }] } })
    expect(requests[0].body.plugins).toEqual([{ id: "web" }])
  })

  it("returns null on a non-2xx response", async () => {
    stubFetch(() => jsonResponse({ error: "nope" }, 500))
    expect(await fastCompletion({ system: "s", user: "u", maxTokens: 10 })).toBeNull()
  })

  it("returns null when the transport throws", async () => {
    stubFetch(() => { throw new Error("network down") })
    expect(await fastCompletion({ system: "s", user: "u", maxTokens: 10 })).toBeNull()
  })

  it("returns null on an empty or malformed completion", async () => {
    stubFetch(() => jsonResponse({ choices: [] }))
    expect(await fastCompletion({ system: "s", user: "u", maxTokens: 10 })).toBeNull()

    stubFetch(() => jsonResponse({ choices: [{ message: { content: "   " } }] }))
    expect(await fastCompletion({ system: "s", user: "u", maxTokens: 10 })).toBeNull()
  })

  it("does not call out at all when no API key is configured", async () => {
    closeDb()
    openDb(":memory:")
    const priorEnv = process.env.OPENROUTER_API_KEY
    delete process.env.OPENROUTER_API_KEY
    stubFetch(() => jsonResponse({ choices: [{ message: { content: "should not happen" } }] }))
    try {
      expect(await fastCompletion({ system: "s", user: "u", maxTokens: 10 })).toBeNull()
      expect(requests).toHaveLength(0)
    } finally {
      if (priorEnv !== undefined) process.env.OPENROUTER_API_KEY = priorEnv
    }
  })
})

describe("fastCompletionMessage", () => {
  it("exposes url_citation annotations alongside the text", async () => {
    stubFetch(() => jsonResponse({
      choices: [{
        message: {
          content: "summary",
          annotations: [{ url_citation: { url: "https://example.com", title: "T", content: "excerpt" } }],
        },
      }],
    }))
    const message = await fastCompletionMessage({ system: "s", user: "u", maxTokens: 10 })
    expect(message?.content).toBe("summary")
    expect(message?.annotations?.[0].url_citation?.url).toBe("https://example.com")
  })
})

describe("fastYesNo", () => {
  it("reads a leading yes as true, case-insensitively", async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: "Yes" } }] }))
    expect(await fastYesNo("s", "u")).toBe(true)
  })

  it("reads anything else as false", async () => {
    stubFetch(() => jsonResponse({ choices: [{ message: { content: "no" } }] }))
    expect(await fastYesNo("s", "u")).toBe(false)

    stubFetch(() => jsonResponse({ choices: [{ message: { content: "it depends" } }] }))
    expect(await fastYesNo("s", "u")).toBe(false)
  })

  it("fails closed when the model is unreachable", async () => {
    stubFetch(() => { throw new Error("network down") })
    expect(await fastYesNo("s", "u")).toBe(false)
  })

  it("fails closed on a non-2xx response", async () => {
    stubFetch(() => jsonResponse({}, 429))
    expect(await fastYesNo("s", "u")).toBe(false)
  })
})

describe("classifiers built on the shared helper", () => {
  it("classifyApprovalReply only ships on a clear affirmative", async () => {
    const { classifyApprovalReply } = await import("../src/services/classify-reply.js")

    stubFetch(() => jsonResponse({ choices: [{ message: { content: "yes" } }] }))
    expect(await classifyApprovalReply("apply it")).toBe(true)

    stubFetch(() => jsonResponse({ choices: [{ message: { content: "no" } }] }))
    expect(await classifyApprovalReply("actually, change the subject line")).toBe(false)

    // The one that matters: an unreachable model must not ship an AI-written fix.
    stubFetch(() => { throw new Error("network down") })
    expect(await classifyApprovalReply("apply it")).toBe(false)

    // An empty reply never reaches the model at all.
    requests = []
    expect(await classifyApprovalReply("   ")).toBe(false)
    expect(requests).toHaveLength(0)
  })

  it("summarizeJigChange degrades to null so the confirmation email still sends", async () => {
    const { summarizeJigChange } = await import("../src/services/summarize-change.js")

    stubFetch(() => jsonResponse({ choices: [{ message: { content: "Now skips replied threads." } }] }))
    expect(await summarizeJigChange("- old\n+ new")).toBe("Now skips replied threads.")

    stubFetch(() => jsonResponse({}, 500))
    expect(await summarizeJigChange("- old\n+ new")).toBeNull()

    expect(await summarizeJigChange("   ")).toBeNull()
  })
})

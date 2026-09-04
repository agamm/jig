import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { probeModel } from "../src/services/model-probe.js"

const realFetch = globalThis.fetch
const realKey = process.env.OPENROUTER_API_KEY
beforeEach(() => { process.env.OPENROUTER_API_KEY = "test-key" })
afterEach(() => {
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = realKey
})

function stubFetch(handler: (url: string, init?: RequestInit) => Response): () => number {
  let calls = 0
  globalThis.fetch = ((input: any, init?: RequestInit) => { calls++; return Promise.resolve(handler(String(input), init)) }) as unknown as typeof fetch
  return () => calls
}

const REFUSAL = "This model requires you to complete the following before use: 18+ age confirmation. Confirm at https://openrouter.ai/settings/preferences."

describe("probeModel", () => {
  it("surfaces the provider message and the URL it names on a 403", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: REFUSAL, code: 403 } }), { status: 403 }))
    const probe = await probeModel("gated/model")
    expect(probe).toEqual({ ok: false, model: "gated/model", error: REFUSAL, fixUrl: "https://openrouter.ai/settings/preferences" })
  })

  it("treats an error body on a 200 as a transient provider failure with the provider's words", async () => {
    stubFetch(() => new Response(JSON.stringify({ error: { message: "Provider returned error", metadata: { raw: "region blocked" } } }), { status: 200 }))
    const probe = await probeModel("blocked/model", { retryDelayMs: 1 })
    expect(probe.ok).toBe(false)
    if (!probe.ok) {
      expect(probe.error).toBe("region blocked")
      expect(probe.transient).toBe(true)
    }
  })

  it("sends a small request and caches a success, never a failure", async () => {
    const calls = stubFetch((_url, init) => {
      const body = JSON.parse(String(init?.body))
      expect(body).toMatchObject({ model: "fine/model", max_tokens: 16 })
      return new Response(JSON.stringify({ choices: [{ message: { content: "pong" } }] }), { status: 200 })
    })
    expect(await probeModel("fine/model")).toEqual({ ok: true, model: "fine/model" })
    expect(await probeModel("fine/model")).toEqual({ ok: true, model: "fine/model" })
    expect(calls()).toBe(1)

    const failing = stubFetch(() => new Response(JSON.stringify({ error: { message: "nope" } }), { status: 403 }))
    await probeModel("flaky/model")
    await probeModel("flaky/model")
    expect(failing()).toBe(2)
  })

  it("unwraps the provider's own message, retries once, and marks a 5xx transient", async () => {
    // OpenRouter wraps upstream failures as "Provider returned error" with the real reason in metadata.raw.
    const calls = stubFetch(() => new Response(JSON.stringify({ error: { message: "Provider returned error", code: 502, metadata: { raw: "max_tokens must be at least 16", provider_name: "Acme" } } }), { status: 502 }))
    const probe = await probeModel("flaky/upstream", { retryDelayMs: 1 })
    expect(probe).toEqual({ ok: false, model: "flaky/upstream", error: "Acme: max_tokens must be at least 16", transient: true })
    expect(calls()).toBe(2)
  })

  it("does not retry or soften a 4xx", async () => {
    const calls = stubFetch(() => new Response(JSON.stringify({ error: { message: "This model requires 18+ age confirmation.", code: 403 } }), { status: 403 }))
    const probe = await probeModel("gated/again", { retryDelayMs: 1 })
    expect(probe.ok).toBe(false)
    if (!probe.ok) expect(probe.transient).toBeUndefined()
    expect(calls()).toBe(1)
  })

  it("reports a missing key without calling out", async () => {
    delete process.env.OPENROUTER_API_KEY
    const calls = stubFetch(() => new Response("{}"))
    const probe = await probeModel("any/model")
    expect(probe.ok).toBe(false)
    expect(calls()).toBe(0)
  })
})

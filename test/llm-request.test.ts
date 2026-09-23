import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, openDb, setCredential } from "../src/db.js"
import { llm } from "../src/sdk/llm.js"

const realFetch = globalThis.fetch
let bodies: any[] = []

function stubCompletion(choice: unknown, usage: unknown = {}) {
  globalThis.fetch = (async (_input: any, init?: any) => {
    bodies.push(JSON.parse(String(init?.body ?? "{}")))
    return new Response(JSON.stringify({ id: "x", object: "chat.completion", choices: [choice], usage }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  }) as typeof fetch
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  bodies = []
  setCredential("openrouter:api_key", "test-key", "openrouter")
})

afterEach(() => {
  globalThis.fetch = realFetch
  closeDb()
})

describe("llm structured requests", () => {
  it("only routes to hosts that honour response_format, so a host that ignores it cannot answer in prose", async () => {
    stubCompletion({ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"n":1}' } })
    await llm("p", {}, { schema: { n: "number" } })
    expect(bodies[0].provider).toEqual({ require_parameters: true })
  })

  it("leaves a reasoning model room to answer after it thinks", async () => {
    stubCompletion({ index: 0, finish_reason: "stop", message: { role: "assistant", content: '{"n":1}' } })
    await llm("p", {}, { schema: { n: "number" } })
    expect(bodies[0].max_tokens).toBeGreaterThanOrEqual(16_000)
  })

  it("names an exhausted budget when the reply is empty, instead of a bare 'empty response'", async () => {
    stubCompletion(
      { index: 0, finish_reason: "length", message: { role: "assistant", content: "" } },
      { completion_tokens: 4096, completion_tokens_details: { reasoning_tokens: 4096 } },
    )
    const error = await llm("p", {}, { schema: { n: "number" }, maxTokens: 4096 }).catch((e: Error) => e)
    expect((error as Error).message).toContain("finish_reason=length")
    expect((error as Error).message).toContain("maxTokens")
  })
})

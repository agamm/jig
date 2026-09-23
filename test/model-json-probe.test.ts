import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { probeJsonMode } from "../src/services/model-probe.js"
import { requireJsonMode } from "../src/server/handlers/admin.js"

const realFetch = globalThis.fetch
const realKey = process.env.OPENROUTER_API_KEY
let bodies: any[] = []
beforeEach(() => { process.env.OPENROUTER_API_KEY = "test-key"; bodies = [] })
afterEach(() => {
  globalThis.fetch = realFetch
  if (realKey === undefined) delete process.env.OPENROUTER_API_KEY
  else process.env.OPENROUTER_API_KEY = realKey
})

function reply(content: string, finish = "stop") {
  globalThis.fetch = ((_input: any, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)))
    return Promise.resolve(new Response(JSON.stringify({ choices: [{ finish_reason: finish, message: { content } }] }), { status: 200 }))
  }) as unknown as typeof fetch
}

describe("probeJsonMode", () => {
  it("passes a model that returns the schema's JSON, asking the way llm() asks", async () => {
    reply('{"answer":100,"unit":"cm"}')
    expect(await probeJsonMode("good/model")).toEqual({ ok: true, model: "good/model" })
    expect(bodies[0].provider).toEqual({ require_parameters: true })
    expect(bodies[0].response_format.type).toBe("json_schema")
  })

  it("fails a model that answers in prose despite JSON mode", async () => {
    reply("We have 100 centimetres in a metre.")
    const probe = await probeJsonMode("prose/model")
    expect(probe.ok).toBe(false)
    if (!probe.ok) expect(probe.error).toContain("ignored JSON mode")
  })

  it("fails a model whose reply is empty, naming the finish reason", async () => {
    reply("", "length")
    const probe = await probeJsonMode("thinker/model")
    expect(probe.ok).toBe(false)
    if (!probe.ok) expect(probe.error).toContain("finish_reason=length")
  })
})

describe("requireJsonMode", () => {
  it("refuses the switch with a 400 when the new model cannot do JSON", async () => {
    reply("Sure! The answer is 100.")
    const error = await requireJsonMode(["prose/model"]).catch((e) => e)
    expect(error?.status).toBe(400)
    expect(error?.message).toContain("Not switching to prose/model")
  })

  it("lets a JSON-capable model through", async () => {
    reply('{"answer":100,"unit":"cm"}')
    await requireJsonMode(["good/model"])
  })
})

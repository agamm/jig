/**
 * The bug this pins: reply-to-edit's inbound webhook is registered at AgentMail
 * once, by name. A backup restored onto a new instance carried the settings and
 * the signing secret, so the new instance reported "reply-to-edit ready" while
 * AgentMail kept posting the owner's replies to the old instance's URL.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, getSetting, openDb, setCredential, setSetting } from "../src/db.js"
import { getAgentMailStatus, setupAgentMail } from "../src/services/agentmail.js"

const realFetch = globalThis.fetch
type Call = { method: string; path: string; body: any }
let calls: Call[] = []
let registered: { webhook_id: string; url: string; client_id: string; secret: string }[] = []

function stubAgentMail(): void {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = String(input)
    const path = url.replace("https://api.agentmail.to/v0", "")
    const method = init?.method ?? "GET"
    const body = init?.body ? JSON.parse(String(init.body)) : null
    calls.push({ method, path, body })
    const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
    if (method === "POST" && path === "/inboxes") return json({ inbox_id: "inbox_1", email: "jig@agentmail.to" })
    if (method === "GET" && path === "/webhooks") return json({ webhooks: registered })
    if (method === "DELETE" && path.startsWith("/webhooks/")) {
      registered = registered.filter((w) => `/webhooks/${w.webhook_id}` !== path)
      return new Response(null, { status: 204 })
    }
    if (method === "POST" && path === "/webhooks") {
      const existing = registered.find((w) => w.client_id === body.client_id)
      if (existing) return json(existing)
      const created = { webhook_id: `wh_${registered.length + 2}`, url: body.url, client_id: body.client_id, secret: `secret_${registered.length + 2}` }
      registered.push(created)
      return json(created)
    }
    return new Response("unexpected " + method + " " + path, { status: 500 })
  }) as unknown as typeof fetch
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  setCredential("agentmail:api_key", "am-test-key", "agentmail")
  setSetting("agentmail", { owner: "owner@example.com" })
  calls = []
  registered = [{ webhook_id: "wh_1", url: "https://old.example/api/email/inbound", client_id: "jig", secret: "secret_old" }]
  stubAgentMail()
})
afterEach(() => {
  globalThis.fetch = realFetch
  delete process.env.JIG_PUBLIC_URL
  closeDb()
})

describe("setupAgentMail", () => {
  it("moves the webhook when it points at another instance, and keeps the new secret", async () => {
    const res = await setupAgentMail("https://new.example/api/email/inbound")

    expect(res.webhookReady).toBe(true)
    expect(calls.some((c) => c.method === "DELETE" && c.path === "/webhooks/wh_1")).toBe(true)
    const create = calls.find((c) => c.method === "POST" && c.path === "/webhooks")
    expect(create?.body.url).toBe("https://new.example/api/email/inbound")
    expect(registered.map((w) => w.url)).toEqual(["https://new.example/api/email/inbound"])
    expect(getSetting<{ webhookUrl?: string }>("agentmail")?.webhookUrl).toBe("https://new.example/api/email/inbound")
  })

  it("leaves a webhook that already points here alone", async () => {
    registered = [{ webhook_id: "wh_1", url: "https://new.example/api/email/inbound", client_id: "jig", secret: "secret_old" }]
    await setupAgentMail("https://new.example/api/email/inbound")
    expect(calls.some((c) => c.method === "DELETE")).toBe(false)
    expect(registered).toHaveLength(1)
  })
})

describe("getAgentMailStatus", () => {
  it("reports reply-to-edit ready only when the registered webhook points at this instance", async () => {
    await setupAgentMail("https://new.example/api/email/inbound")

    process.env.JIG_PUBLIC_URL = "https://new.example"
    expect(getAgentMailStatus()).toMatchObject({ webhookReady: true, webhookMismatch: false })

    // The shape a restored backup produces: settings from the old instance, a new URL here.
    process.env.JIG_PUBLIC_URL = "https://newer.example"
    expect(getAgentMailStatus()).toMatchObject({ webhookReady: false, webhookMismatch: true, webhookUrl: "https://new.example/api/email/inbound" })
  })
})

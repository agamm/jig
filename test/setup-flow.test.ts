import { describe, expect, it } from "bun:test"
import { runSetupFlow, type SetupBackend, type SetupEvent, type SetupIO } from "../shared/setup-flow.js"
import type { Connection, VerifyConnectionResponse } from "../shared/api.js"

const OK_VERIFY: VerifyConnectionResponse = {
  ok: true,
  server: "composio",
  level: "probe",
  tool: "COMPOSIO_SEARCH_TOOLS",
  summary: "composio: 3 toolkits connected",
  durationMs: 12,
}

function makeIO(answers: { ask?: string[]; secret?: string[]; confirm?: boolean[] } = {}) {
  const events: SetupEvent[] = []
  const opened: string[] = []
  const ask = [...(answers.ask ?? [])]
  const secret = [...(answers.secret ?? [])]
  const confirm = [...(answers.confirm ?? [])]
  const io: SetupIO = {
    ask: async () => ask.shift() ?? "",
    askSecret: async () => secret.shift() ?? "",
    confirm: async () => confirm.shift() ?? false,
    openUrl: async (url) => { opened.push(url); return true },
    emit: (event) => events.push(event),
    wait: async () => {}, // never actually sleep in tests
  }
  return { io, events, opened }
}

function makeBackend(overrides: Partial<SetupBackend> = {}): SetupBackend {
  const connections: Connection[] = [
    { name: "composio", connected: true, toolCount: 9, description: "250+ apps", proxyDashboardUrl: "https://dashboard.composio.dev/" },
  ]
  return {
    openRouterCredits: async () => ({ ok: true, balance: 12.5 }),
    setOpenRouterKey: async () => {},
    agentMailStatus: async () => ({ hasKey: true, owner: "owner@example.com", address: "jig@agentmail.to", canSend: true, webhookReady: true }),
    saveAgentMail: async () => {},
    provisionAgentMailInbox: async () => ({ ok: true, address: "jig@agentmail.to", webhookReady: true }),
    sendAgentMailTest: async () => ({ ok: true }),
    listConnections: async () => connections,
    connect: async () => ({ ok: true as const, server: "composio", toolCount: 9, tools: [] }),
    verify: async () => OK_VERIFY,
    ...overrides,
  }
}

const verifiedIds = (events: SetupEvent[]) =>
  events.filter((e) => e.type === "verified").map((e) => (e as { id: string }).id)

describe("runSetupFlow", () => {
  it("skips work that is already satisfied, so re-running setup resumes", async () => {
    const { io, events } = makeIO({ confirm: [true] })
    let keyWrites = 0
    const result = await runSetupFlow(io, makeBackend({ setOpenRouterKey: async () => { keyWrites++ } }))

    expect(keyWrites).toBe(0) // credits already valid, so never asked for a key
    expect(events.some((e) => e.type === "step-satisfied" && e.id === "openrouter")).toBe(true)
    expect(result.verified).toEqual(["openrouter", "agentmail", "composio"])
  })

  it("does NOT mark a connection verified when verification fails", async () => {
    const { io, events } = makeIO({ confirm: [true] })
    const result = await runSetupFlow(
      io,
      makeBackend({
        verify: async () => ({ ok: false, server: "composio", level: "handshake", error: "token expired" }),
      }),
    )

    expect(result.verified).not.toContain("composio")
    expect(result.skipped).toContain("composio")
    expect(verifiedIds(events)).not.toContain("composio")
    expect(events.some((e) => e.type === "step-failed" && e.message.includes("token expired"))).toBe(true)
  })

  it("verifies a connection AFTER oauth completes, never before", async () => {
    // Connection flips to connected only on the third poll. The wizard must not
    // call verify until then, otherwise it would verify a half-finished OAuth.
    let polls = 0
    const order: string[] = []
    const { io } = makeIO({ confirm: [true] })
    await runSetupFlow(
      io,
      makeBackend({
        listConnections: async () => {
          polls++
          order.push(`list:${polls}`)
          return [{ name: "composio", connected: polls >= 3, toolCount: 0, description: "" }]
        },
        connect: async () => ({ ok: false as const, server: "composio", awaitingOAuth: true as const, authorizationUrl: "https://login.composio.dev/x" }),
        verify: async () => { order.push("verify"); return OK_VERIFY },
      }),
      { pollIntervalMs: 0 },
    )

    expect(order[order.length - 1]).toBe("verify")
    expect(polls).toBeGreaterThanOrEqual(3)
  })

  it("opens the authorization URL, because the server will not in service mode", async () => {
    const { io, opened } = makeIO({ confirm: [true] })
    // Must start DISCONNECTED, otherwise the wizard rightly skips the OAuth
    // path entirely and there is no URL to open.
    let seen = 0
    await runSetupFlow(
      io,
      makeBackend({
        listConnections: async () => [{ name: "composio", connected: seen++ > 0, toolCount: 0, description: "" }],
        connect: async () => ({ ok: false as const, server: "composio", awaitingOAuth: true as const, authorizationUrl: "https://login.composio.dev/authorize?x=1" }),
      }),
      { pollIntervalMs: 0 },
    )
    expect(opened).toContain("https://login.composio.dev/authorize?x=1")
  })

  it("aborts when a REQUIRED step fails", async () => {
    const { io, events } = makeIO()
    await expect(
      runSetupFlow(io, makeBackend({ sendAgentMailTest: async () => ({ ok: false, error: "inbox not provisioned" }) })),
    ).rejects.toThrow(/inbox not provisioned/)

    // composio must never have been attempted after a required failure
    expect(events.some((e) => e.type === "step-begin" && e.id === "composio")).toBe(false)
  })

  it("continues when an OPTIONAL step is declined", async () => {
    const { io } = makeIO({ confirm: [false] })
    const result = await runSetupFlow(io, makeBackend({ listConnections: async () => [{ name: "composio", connected: false, toolCount: 0, description: "" }] }))

    expect(result.verified).toEqual(["openrouter", "agentmail"])
    expect(result.skipped).toEqual(["composio"])
  })

  it("rejects a bad OpenRouter key on the balance check rather than trusting the paste", async () => {
    const { io } = makeIO({ secret: ["sk-or-bogus"] })
    let calls = 0
    await expect(
      runSetupFlow(
        io,
        makeBackend({
          // First call reports no key; after the paste it still fails.
          openRouterCredits: async () => { calls++; return { ok: false, error: "401 unauthorized" } },
        }),
      ),
    ).rejects.toThrow(/401 unauthorized/)
    expect(calls).toBe(2) // checked before AND after the paste
  })

  it("warns about a zero balance instead of calling it healthy", async () => {
    const { io, events } = makeIO({ confirm: [true] })
    await runSetupFlow(io, makeBackend({ openRouterCredits: async () => ({ ok: true, balance: 0 }) }))
    const verified = events.find((e) => e.type === "verified" && e.id === "openrouter") as { summary: string }
    expect(verified.summary).toMatch(/balance is 0/)
  })

  it("surfaces the composio app recommendations after verifying", async () => {
    const { io, events } = makeIO({ confirm: [true] })
    await runSetupFlow(io, makeBackend())
    const rec = events.find((e) => e.type === "recommendations") as { apps: { name: string }[]; dashboardUrl?: string }
    expect(rec.apps.map((a) => a.name)).toEqual(["Gmail", "Google Calendar", "Telegram or Slack"])
    expect(rec.dashboardUrl).toBe("https://dashboard.composio.dev/")
  })
})

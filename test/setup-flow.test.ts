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

function makeIO(answers: { ask?: string[]; secret?: string[]; confirm?: boolean[]; canPrompt?: boolean } = {}) {
  const events: SetupEvent[] = []
  const opened: string[] = []
  const secretsAsked: string[] = []
  const ask = [...(answers.ask ?? [])]
  const secret = [...(answers.secret ?? [])]
  const confirm = [...(answers.confirm ?? [])]
  const io: SetupIO = {
    canPrompt: () => answers.canPrompt ?? true,
    ask: async () => ask.shift() ?? "",
    askSecret: async (question) => { secretsAsked.push(question); return secret.shift() ?? "" },
    confirm: async () => confirm.shift() ?? false,
    openUrl: async (url) => { opened.push(url); return true },
    emit: (event) => events.push(event),
    wait: async () => {}, // never actually sleep in tests
  }
  return { io, events, opened, secretsAsked }
}

function makeBackend(overrides: Partial<SetupBackend> = {}): SetupBackend {
  const connections: Connection[] = [
    { name: "composio", connected: true, toolCount: 9, description: "250+ apps", proxyDashboardUrl: "https://dashboard.composio.dev/" },
  ]
  return {
    openRouterCredits: async () => ({ ok: true, balance: 12.5 }),
    setOpenRouterKey: async () => {},
    startOpenRouterOAuth: async () => ({ authorizationUrl: "https://openrouter.ai/auth?code_challenge=abc&code_challenge_method=S256" }),
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
      runSetupFlow(io, makeBackend({ openRouterCredits: async () => ({ ok: false, error: "no key" }) }), { oauthTimeoutMs: 0 }),
    ).rejects.toThrow(/Timed out waiting for OpenRouter/)

    // composio must never have been attempted after a required failure
    expect(events.some((e) => e.type === "step-begin" && e.id === "composio")).toBe(false)
  })

  it("aborts when ALERTS fail, because a silent failure channel is not optional", async () => {
    const { io, events } = makeIO({ confirm: [true] })
    await expect(
      runSetupFlow(io, makeBackend({ sendAgentMailTest: async () => ({ ok: false, error: "inbox not provisioned" }) })),
    ).rejects.toThrow(/inbox not provisioned/)

    expect(events.some((e) => e.type === "step-begin" && e.id === "composio")).toBe(false)
  })

  it("continues when an OPTIONAL step is declined", async () => {
    const { io } = makeIO({ confirm: [false] })
    const result = await runSetupFlow(io, makeBackend({ listConnections: async () => [{ name: "composio", connected: false, toolCount: 0, description: "" }] }))

    expect(result.verified).toEqual(["openrouter", "agentmail"])
    expect(result.skipped).toEqual(["composio"])
  })

  it("authorizes OpenRouter in the browser and never asks for a key", async () => {
    // Credits report nothing until the callback stores the key, which is the
    // only signal the wizard gets that the browser half finished.
    let polls = 0
    const { io, opened, secretsAsked, events } = makeIO({ confirm: [true] })
    const result = await runSetupFlow(
      io,
      makeBackend({ openRouterCredits: async () => (polls++ >= 2 ? { ok: true, balance: 5 } : { ok: false, error: "no key yet" }) }),
      { pollIntervalMs: 0 },
    )

    expect(opened[0]).toContain("https://openrouter.ai/auth")
    expect(secretsAsked).toEqual([]) // the whole point: no key is ever requested
    expect(result.verified).toContain("openrouter")
    expect(events.some((e) => e.type === "waiting" && e.id === "openrouter")).toBe(true)
  })

  it("does not call OpenRouter verified until the balance check passes", async () => {
    // A key that never lands must fail the step, not be assumed good because
    // the browser was opened.
    const { io } = makeIO()
    let calls = 0
    await expect(
      runSetupFlow(
        io,
        makeBackend({ openRouterCredits: async () => { calls++; return { ok: false, error: "401 unauthorized" } } }),
        { oauthTimeoutMs: 0 },
      ),
    ).rejects.toThrow(/Timed out waiting for OpenRouter/)
    expect(calls).toBe(1) // checked up front; the poll loop never got a passing balance
  })

  it("finishes alerts in the dashboard when there is no terminal to paste into", async () => {
    // A coding agent has no TTY, and AgentMail has no authorization to redirect
    // through, so the wizard must hand the same two fields to a browser rather
    // than prompting into the void or failing a required step.
    let polls = 0
    const { io, opened, secretsAsked } = makeIO({ canPrompt: false })
    const result = await runSetupFlow(
      io,
      makeBackend({
        agentMailStatus: async () =>
          polls++ >= 2
            ? { hasKey: true, owner: "owner@example.com", address: "jig@agentmail.to", canSend: true, webhookReady: true }
            : { hasKey: false, owner: null, address: null, canSend: false, webhookReady: false },
      }),
      { pollIntervalMs: 0, dashboardUrl: "http://localhost:3141" },
    )

    expect(secretsAsked).toEqual([]) // never prompts where nobody can answer
    expect(opened).toContain("http://localhost:3141/?view=settings&tab=notifications")
    expect(result.verified).toContain("agentmail")
  })

  it("says how to supply the key when there is neither a terminal nor a dashboard", async () => {
    const { io } = makeIO({ canPrompt: false })
    await expect(
      runSetupFlow(
        io,
        makeBackend({
          agentMailStatus: async () => ({ hasKey: false, owner: null, address: null, canSend: false, webhookReady: false }),
        }),
        { pollIntervalMs: 0 },
      ),
    ).rejects.toThrow(/`jig start` and re-run setup, or pass --agentmail-key=<key>/)
  })

  it("walks the user through creating the key rather than naming the service", async () => {
    const { io, events } = makeIO({ secret: ["am_test"], ask: ["owner@example.com"] })
    await runSetupFlow(
      io,
      makeBackend({
        agentMailStatus: async () => ({ hasKey: false, owner: "owner@example.com", address: "jig@agentmail.to", canSend: true, webhookReady: true }),
      }),
    )

    const said = events.filter((e) => e.type === "instruction").map((e) => (e as { message: string }).message)
    expect(said.some((m) => m.includes("API Keys in the left sidebar"))).toBe(true)
    expect(said.some((m) => m.includes("shows a key once"))).toBe(true)
  })

  it("uses a pre-seeded AgentMail key without prompting or a browser detour", async () => {
    // What `--agentmail-key` does: the CLI saves it before the flow, so the step
    // finds itself satisfied and never opens its dialogue.
    const { io, secretsAsked, opened } = makeIO({ canPrompt: false })
    const result = await runSetupFlow(io, makeBackend())

    expect(secretsAsked).toEqual([])
    expect(opened.some((u) => u.includes("agentmail"))).toBe(false)
    expect(result.verified).toContain("agentmail")
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

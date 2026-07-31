/**
 * Tests for the notify() failure-alert service — behaviour only, no network.
 * AgentMail state is seeded straight into an in-memory DB (credentials +
 * settings rows) and the send is injected via opts.sendEmail.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { openDb, closeDb, getEmailThread, setCredential, setSetting } from "../src/db.js"
import { notify, formatFailureBody } from "../src/services/notify.js"

type SentEmail = { to: string; subject: string; text?: string; html?: string }

/** Records what would have gone out and returns AgentMail-shaped ids. */
function recorder(sent: SentEmail[]) {
  return async (opts: SentEmail) => {
    sent.push(opts)
    return { threadId: "thread_1", messageId: "msg_1" }
  }
}

/** AgentMail able to send: api key + provisioned inbox + owner. */
function seedSendable(overrides: Record<string, unknown> = {}) {
  setCredential("agentmail:api_key", "am_test_key", "agentmail")
  setSetting("agentmail", {
    inboxId: "inbox_1",
    address: "jig-test@agentmail.to",
    owner: "owner@example.com",
    ...overrides,
  })
}

/** The extra piece reply-to-edit needs: a registered inbound webhook. */
function seedWebhook() {
  setCredential("agentmail:webhook_secret", "whsec_test", "agentmail")
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

describe("notify()", () => {
  it("emails the owner when AgentMail can send", async () => {
    seedSendable()
    const sent: SentEmail[] = []

    const delivered = await notify({
      title: 'Jig "morning" failed',
      body: "Error: timeout",
      kind: "fail",
      sendEmail: recorder(sent),
    })

    expect(delivered).toBe(true)
    expect(sent).toHaveLength(1)
    expect(sent[0].to).toBe("owner@example.com")
    expect(sent[0].subject).toBe('Jig "morning" failed')
    expect(sent[0].text).toBe("Error: timeout")
  })

  it("sends nothing when AgentMail is not set up", async () => {
    const sent: SentEmail[] = []
    const delivered = await notify({
      title: "T", body: "B", kind: "fail",
      sendEmail: recorder(sent),
    })
    expect(delivered).toBe(false)
    expect(sent).toEqual([])
  })

  it("sends nothing when failure alerts are turned off", async () => {
    seedSendable({ notifyOnFailure: false })
    const sent: SentEmail[] = []
    const delivered = await notify({
      title: "T", body: "B", kind: "fail",
      sendEmail: recorder(sent),
    })
    expect(delivered).toBe(false)
    expect(sent).toEqual([])
  })

  it("ignoreTriggerGate sends a test even when failure alerts are off", async () => {
    seedSendable({ notifyOnFailure: false })
    const sent: SentEmail[] = []
    const delivered = await notify({
      title: "T", body: "B", kind: "fail",
      ignoreTriggerGate: true,
      sendEmail: recorder(sent),
    })
    expect(delivered).toBe(true)
    expect(sent).toHaveLength(1)
  })

  it("makes the email repliable and records the thread when the webhook is wired and a jig is known", async () => {
    seedSendable()
    seedWebhook()
    const sent: SentEmail[] = []

    await notify({
      title: "Jig failed", body: "Error: boom", kind: "fail",
      jigId: "morning-calendar",
      sendEmail: recorder(sent),
    })

    // Token appears in both the subject and the body footer so it survives
    // whichever half of the reply the mail client preserves.
    const token = sent[0].subject.match(/\[#([A-Z0-9]+)\]$/)?.[1]
    expect(token).toBeTruthy()
    expect(sent[0].text).toContain(`#${token}`)
    expect(sent[0].text).toContain("Reply to this email to fix the jig")

    const thread = getEmailThread("thread_1")
    expect(thread?.jig_id).toBe("morning-calendar")
    expect(thread?.reply_token).toBe(token!)
  })

  it("sends a plain alert — no token, no thread — without the inbound webhook", async () => {
    seedSendable()
    const sent: SentEmail[] = []

    await notify({
      title: "Jig failed", body: "Error: boom", kind: "fail",
      jigId: "morning-calendar",
      sendEmail: recorder(sent),
    })

    expect(sent[0].subject).toBe("Jig failed")
    expect(sent[0].text).toBe("Error: boom")
    expect(getEmailThread("thread_1")).toBeNull()
  })

  it("sends a plain alert when the webhook is wired but no jig is known", async () => {
    seedSendable()
    seedWebhook()
    const sent: SentEmail[] = []

    await notify({ title: "Scheduler died", body: "B", kind: "fail", sendEmail: recorder(sent) })

    expect(sent[0].subject).toBe("Scheduler died")
    expect(getEmailThread("thread_1")).toBeNull()
  })

  it("never throws when the send fails", async () => {
    seedSendable()
    let delivered: boolean | undefined

    await expect((async () => {
      delivered = await notify({
        title: "T", body: "B", kind: "fail",
        sendEmail: async () => { throw new Error("AgentMail API error 500") },
      })
    })()).resolves.toBeUndefined()

    expect(delivered).toBe(false)
  })

  it("never throws when the agentmail settings row is malformed", async () => {
    const db = openDb()
    db.prepare(
      `INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('agentmail', 'not json', datetime('now'))`
    ).run()

    const sent: SentEmail[] = []
    let delivered: boolean | undefined
    await expect((async () => {
      delivered = await notify({ title: "T", body: "B", kind: "fail", sendEmail: recorder(sent) })
    })()).resolves.toBeUndefined()

    expect(delivered).toBe(false)
    expect(sent).toEqual([])
  })
})

describe("formatFailureBody", () => {
  it("includes all known fields", () => {
    const s = formatFailureBody({
      jigId: "morning-calendar",
      error: "Timed out after 10 minutes",
      startedAt: "2026-04-09 08:00:12",
      durationMs: 603_000,
      dashboardBaseUrl: "http://localhost:3141",
    })
    expect(s).toContain("Error: Timed out after 10 minutes")
    expect(s).toContain("Duration: 10m 3s")
    expect(s).toContain("http://localhost:3141/jigs/morning-calendar")
  })
})

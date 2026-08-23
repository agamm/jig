import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { createHmac } from "node:crypto"
import { closeDb, deleteJigInbox, getJigByInboxId, openDb, recordEmailThread, recordJigInbox, setCredential, setSetting } from "../src/db.js"
import { emailRunParams, handleInboundEmail, type InboundEmailDeps } from "../src/services/email-inbound.js"

const OWNER = "owner@example.com"
const JIG = "todo"
const JIG_INBOX = "todo-a1b2c3@agentmail.to"
const MAIN_INBOX = "jig-main@agentmail.to"
const SECRET_RAW = Buffer.from("test-webhook-signing-secret-000000").toString("base64")
const SECRET = `whsec_${SECRET_RAW}`

/** Sign a body the way AgentMail (Svix) does, so the real gate 1 passes. */
function signedHeaders(body: string): Headers {
  const id = "msg_test"
  const timestamp = String(Math.floor(Date.now() / 1000))
  const signature = createHmac("sha256", Buffer.from(SECRET_RAW, "base64"))
    .update(`${id}.${timestamp}.${body}`)
    .digest("base64")
  return new Headers({
    "svix-id": id,
    "svix-timestamp": timestamp,
    "svix-signature": `v1,${signature}`,
  })
}

function payload(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "event",
    event_type: "message.received",
    event_id: "evt_1",
    message: {
      inbox_id: JIG_INBOX,
      thread_id: "thread_1",
      message_id: "msg_1",
      from: OWNER,
      to: [JIG_INBOX],
      subject: "Renew passport",
      text: "Remind me to renew my passport on Thursday",
      timestamp: "2026-08-19T10:00:00Z",
      ...over,
    },
  })
}

function deps(over: Partial<InboundEmailDeps> = {}) {
  const runs: Array<{ jigId: string; params: Record<string, unknown> }> = []
  const replies: string[] = []
  const d: InboundEmailDeps = {
    startRun: async (jigId, params) => { runs.push({ jigId, params }); return true },
    reply: async (opts) => { replies.push(opts.text) },
    isRunning: () => false,
    getSchedule: () => ({ enabled: true }),
    ...over,
  }
  return { d, runs, replies }
}

describe("inbound email routing", () => {
  beforeEach(() => {
    openDb()
    setCredential("agentmail:webhook_secret", SECRET, "agentmail")
    setSetting("agentmail", { inboxId: MAIN_INBOX, address: MAIN_INBOX, owner: OWNER, notifyOnFailure: true })
    recordJigInbox(JIG, JIG_INBOX, JIG_INBOX)
  })
  afterEach(() => {
    deleteJigInbox(JIG)
    closeDb()
  })

  it("routes mail in a jig's own inbox to that jig as data", async () => {
    const { d, runs } = deps()
    const body = payload()
    const res = await handleInboundEmail(body, signedHeaders(body), d)

    // 202: the run was accepted, not completed. See the no-blocking test below.
    expect(res.status).toBe(202)
    expect(runs).toHaveLength(1)
    expect(runs[0].jigId).toBe(JIG)
    expect(runs[0].params).toEqual({
      email: {
        from: OWNER,
        subject: "Renew passport",
        text: "Remind me to renew my passport on Thursday",
        messageId: "msg_1",
        threadId: "thread_1",
        receivedAt: "2026-08-19T10:00:00Z",
      },
    })
  })

  // The whole reason inbox routing runs before thread routing: a first-contact
  // email has no thread mapping, and the authoring path drops it as "unknown
  // thread". This is the case the feature exists for.
  it("delivers a brand-new email with no thread mapping", async () => {
    const { d, runs } = deps()
    const body = payload({ thread_id: "never-seen-before" })
    await handleInboundEmail(body, signedHeaders(body), d)
    expect(runs).toHaveLength(1)
  })

  // Gate 3 must still bite on the data path. Otherwise anyone who learns the
  // jig's address can inject to-dos into it.
  it("rejects mail from anyone but the owner", async () => {
    const { d, runs } = deps()
    const body = payload({ from: "stranger@elsewhere.com" })
    const res = await handleInboundEmail(body, signedHeaders(body), d)

    expect(res.body).toMatchObject({ ignored: "sender is not the owner" })
    expect(runs).toHaveLength(0)
  })

  it("rejects an unsigned request before looking at anything else", async () => {
    const { d, runs } = deps()
    const res = await handleInboundEmail(payload(), new Headers({}), d)

    expect(res.status).toBe(401)
    expect(runs).toHaveLength(0)
  })

  // Spam and unauthenticated mail arrive as different event types; only
  // message.received has cleared SPF/DKIM/DMARC at AgentMail.
  it("ignores event types other than message.received", async () => {
    const { d, runs } = deps()
    const body = payload().replace('"message.received"', '"message.received.spam"')
    await handleInboundEmail(body, signedHeaders(body), d)
    expect(runs).toHaveLength(0)
  })

  // A reply about a broken jig must still reach the authoring agent, not be
  // swallowed by the data path.
  it("leaves mail in the main inbox on the authoring path", async () => {
    const { d, runs } = deps()
    recordEmailThread("thread_1", "some-other-jig", "auto", "tok")
    const body = payload({ inbox_id: MAIN_INBOX })
    const res = await handleInboundEmail(body, signedHeaders(body), d)

    // Falls through to the token gate rather than running a jig with the text.
    expect(runs).toHaveLength(0)
    expect(res.body).toMatchObject({ ignored: "reply token missing or mismatched" })
  })

  it("ignores an inbox that maps to no jig", async () => {
    const { d, runs } = deps()
    // A thread id with no mapping either, so this lands on the authoring path's
    // own "unknown thread" exit rather than on any leftover thread row.
    const body = payload({ inbox_id: "unknown@agentmail.to", thread_id: "thread_unmapped" })
    const res = await handleInboundEmail(body, signedHeaders(body), d)

    expect(runs).toHaveLength(0)
    expect(res.body).toMatchObject({ ignored: "unknown thread" })
  })

  it("tells the user when the jig was already running rather than dropping the mail", async () => {
    const { d, runs, replies } = deps({ isRunning: () => true })
    const body = payload()
    const res = await handleInboundEmail(body, signedHeaders(body), d)

    expect(runs).toHaveLength(0)
    expect(replies[0]).toContain("already running")
    expect(res.body).toMatchObject({ error: "run in progress" })
  })

  /**
   * The webhook POST must be answered immediately. startBackgroundRun awaits
   * the run to completion, so awaiting it here would hold Svix open for the
   * whole run; Svix times out around 15s and redelivers, which either files the
   * item twice or reports a failure for a run that is actually succeeding.
   */
  it("answers the webhook without waiting for the run to finish", async () => {
    const { d, replies } = deps({ startRun: () => new Promise<boolean>(() => {}) })
    const body = payload()

    const res = await Promise.race([
      handleInboundEmail(body, signedHeaders(body), d),
      new Promise((resolve) => setTimeout(() => resolve("timed out"), 500)),
    ])

    expect(res).not.toBe("timed out")
    expect((res as { status: number }).status).toBe(202)
    expect(replies).toHaveLength(0)
  })

  // Pausing a jig on the dashboard must actually stop it, the way it does for
  // the webhook trigger (scheduler/webhooks.ts returns 403 for a paused jig).
  it("does not run a paused jig", async () => {
    const { d, runs, replies } = deps({ getSchedule: () => ({ enabled: false }) })
    const body = payload()
    const res = await handleInboundEmail(body, signedHeaders(body), d)

    expect(runs).toHaveLength(0)
    expect(replies[0]).toContain("paused")
    expect(res.body).toMatchObject({ ignored: "schedule disabled" })
  })

  // A jig with no schedule row is manual-triggered, not paused.
  it("still runs a jig that has no schedule row", async () => {
    const { d, runs } = deps({ getSchedule: () => null })
    const body = payload()
    await handleInboundEmail(body, signedHeaders(body), d)
    expect(runs).toHaveLength(1)
  })

  it("does not start a run for an empty message", async () => {
    const { d, runs } = deps()
    const body = payload({ text: "   " })
    const res = await handleInboundEmail(body, signedHeaders(body), d)

    expect(runs).toHaveLength(0)
    expect(res.body).toMatchObject({ ignored: "empty email body" })
  })
})

describe("emailRunParams", () => {
  // On a threaded reply, `text` carries the whole quoted history, handing the
  // jig its own previous email back as new input.
  it("prefers AgentMail's extracted text over the full body", () => {
    const params = emailRunParams({
      extracted_text: "Snooze that one",
      text: "Snooze that one\n\nOn Tue, Jig wrote:\n> Reminder: renew passport",
      from: `Owner <${OWNER}>`,
    }, "msg_1")
    expect(params?.email.text).toBe("Snooze that one")
  })

  it("falls back to the raw body when nothing was extracted", () => {
    const params = emailRunParams({ text: "Buy milk", from: OWNER }, "msg_1")
    expect(params?.email.text).toBe("Buy milk")
  })

  // SKILL.md documents this field as "quoted reply history already stripped",
  // so the fallback has to honour that too, not just the Talon path.
  it("still strips quoted history when AgentMail extracted nothing", () => {
    const params = emailRunParams({
      text: "and also book the dentist\n\nOn Tue, Jig wrote:\n> Got it: Renew passport",
      from: OWNER,
    }, "msg_1")
    expect(params?.email.text).toBe("and also book the dentist")
  })

  it("normalizes a display-name From to a bare address", () => {
    const params = emailRunParams({ text: "x", from: `Owner Name <${OWNER}>` }, "msg_1")
    expect(params?.email.from).toBe(OWNER)
  })

  it("returns null when there is no text at all", () => {
    expect(emailRunParams({ from: OWNER }, "msg_1")).toBeNull()
  })

  it("stamps a receipt time when the message carries none", () => {
    const params = emailRunParams({ text: "x" }, "msg_1", () => new Date("2026-01-02T03:04:05Z"))
    expect(params?.email.receivedAt).toBe("2026-01-02T03:04:05.000Z")
  })
})

describe("jig inbox routing table", () => {
  beforeEach(() => { openDb() })
  afterEach(() => { deleteJigInbox(JIG); closeDb() })

  it("finds the jig that owns an inbox", () => {
    recordJigInbox(JIG, JIG_INBOX, JIG_INBOX)
    expect(getJigByInboxId(JIG_INBOX)?.jig_id).toBe(JIG)
  })

  it("returns null for an inbox no jig owns", () => {
    expect(getJigByInboxId("nobody@agentmail.to")).toBeNull()
  })

  // Re-syncing must not create a second row or a second address for one jig.
  it("is idempotent for the same jig", () => {
    recordJigInbox(JIG, JIG_INBOX, JIG_INBOX)
    recordJigInbox(JIG, JIG_INBOX, JIG_INBOX)
    expect(getJigByInboxId(JIG_INBOX)?.jig_id).toBe(JIG)
  })
})

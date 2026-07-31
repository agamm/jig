import { describe, it, expect, afterEach } from "bun:test"
import { Context } from "../src/sdk/context"
import { setDryRun } from "../src/sdk/dryrun"

describe("ctx.email", () => {
  afterEach(() => setDryRun(false))

  it("dry-run: never sends, returns a stub, and logs the intent", async () => {
    setDryRun(true)
    const ctx = new Context({}, { jigId: "daily-digest" })
    const res = await ctx.email({ subject: "Daily digest", html: "<p>hi</p>" })
    expect(res).toEqual({ threadId: "dry-run", messageId: "dry-run" })
    expect(ctx.getOutput().join("\n")).toContain("[dry-run] would email you: Daily digest")
  })

  it("throws a clear error when AgentMail can't send (not configured)", async () => {
    // Local test DB has no AgentMail config → canSendAgentMail() is false.
    setDryRun(false)
    const ctx = new Context({}, { jigId: "daily-digest" })
    await expect(ctx.email({ subject: "Daily digest", text: "hi" })).rejects.toThrow(/AgentMail/)
  })
})

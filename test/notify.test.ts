/**
 * Tests for the notify() service — behaviour-only, no MCP network.
 * Uses the toolCaller/settingsOverride/manifestOverride injection points
 * so nothing touches disk or real connections.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { openDb, closeDb } from "../src/db.js"
import {
  notify,
  getNotificationSettings,
  saveNotificationSettings,
  formatFailureBody,
  type NotificationSettings,
} from "../src/services/notify.js"
import type { NotificationCapableTool } from "../src/mcp/discover/notification-manifest.js"

const telegramManifest: NotificationCapableTool = {
  connection: "composio",
  tool: "telegram_send_message",
  label: "Telegram",
  description: "Send a text message",
  textField: "text",
  recipientField: "chat_id",
  extraRequired: [],
}
const gmailManifest: NotificationCapableTool = {
  connection: "workspace",
  tool: "gmail_send",
  label: "Gmail",
  description: "Send an email",
  textField: "body",
  recipientField: "to",
  extraRequired: ["subject"],
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

function baseSettings(overrides: Partial<NotificationSettings> = {}): NotificationSettings {
  return {
    channels: [],
    triggerOn: { fail: true },
    ...overrides,
  }
}

describe("notify()", () => {
  it("empty channels → no calls, empty report", async () => {
    let calls = 0
    const report = await notify({
      title: "T", body: "B", kind: "fail",
      toolCaller: async () => { calls++; return null },
      settingsOverride: baseSettings(),
      manifestOverride: [telegramManifest],
    })
    expect(calls).toBe(0)
    expect(report.sent).toEqual([])
    expect(report.errors).toEqual([])
  })

  it("triggerOn.fail === false → no calls on fail event", async () => {
    let calls = 0
    const report = await notify({
      title: "T", body: "B", kind: "fail",
      toolCaller: async () => { calls++; return null },
      settingsOverride: baseSettings({
        channels: [{ connection: "composio", tool: "telegram_send_message", recipient: "42" }],
        triggerOn: { fail: false },
      }),
      manifestOverride: [telegramManifest],
    })
    expect(calls).toBe(0)
    expect(report.sent).toEqual([])
  })

  it("single telegram channel → caller invoked with correct payload", async () => {
    const seen: any[] = []
    const report = await notify({
      title: "Jig \"morning\" failed", body: "Error: timeout", kind: "fail",
      toolCaller: async (conn, tool, params) => { seen.push({ conn, tool, params }); return null },
      settingsOverride: baseSettings({
        channels: [{ connection: "composio", tool: "telegram_send_message", recipient: "8465930881" }],
      }),
      manifestOverride: [telegramManifest],
    })
    expect(seen).toHaveLength(1)
    expect(seen[0].conn).toBe("composio")
    expect(seen[0].tool).toBe("telegram_send_message")
    expect(seen[0].params.chat_id).toBe("8465930881")
    expect(seen[0].params.text).toBe("Jig \"morning\" failed\n\nError: timeout")
    expect(report.sent).toEqual([{ channel: "Telegram", ok: true }])
    expect(report.errors).toEqual([])
  })

  it("gmail channel constructs to/body/subject via extraParams", async () => {
    const seen: any[] = []
    await notify({
      title: "Title", body: "Body", kind: "fail",
      toolCaller: async (conn, tool, params) => { seen.push(params); return null },
      settingsOverride: baseSettings({
        channels: [{
          connection: "workspace",
          tool: "gmail_send",
          recipient: "alerts@example.com",
          extraParams: { subject: "Jig alert" },
        }],
      }),
      manifestOverride: [gmailManifest],
    })
    expect(seen[0].to).toBe("alerts@example.com")
    expect(seen[0].body).toBe("Title\n\nBody")
    expect(seen[0].subject).toBe("Jig alert")
  })

  it("multi-channel uses allSettled — partial success reported", async () => {
    const report = await notify({
      title: "T", body: "B", kind: "fail",
      toolCaller: async (conn) => {
        if (conn === "workspace") throw new Error("smtp 500")
        return null
      },
      settingsOverride: baseSettings({
        channels: [
          { connection: "composio", tool: "telegram_send_message", recipient: "42" },
          { connection: "workspace", tool: "gmail_send", recipient: "x@y.com", extraParams: { subject: "s" } },
        ],
      }),
      manifestOverride: [telegramManifest, gmailManifest],
    })
    expect(report.sent).toEqual([{ channel: "Telegram", ok: true }])
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0].channel).toBe("Gmail")
    expect(report.errors[0].error).toContain("smtp 500")
  })

  it("tool missing from manifest → recorded as error, siblings still fire", async () => {
    const seen: string[] = []
    const report = await notify({
      title: "T", body: "B", kind: "fail",
      toolCaller: async (conn, tool) => { seen.push(`${conn}.${tool}`); return null },
      settingsOverride: baseSettings({
        channels: [
          { connection: "composio", tool: "telegram_send_message", recipient: "42" },
          { connection: "composio", tool: "nonexistent_sender", recipient: "x" },
        ],
      }),
      manifestOverride: [telegramManifest],
    })
    expect(seen).toEqual(["composio.telegram_send_message"])
    expect(report.sent).toHaveLength(1)
    expect(report.errors).toHaveLength(1)
    expect(report.errors[0].error).toContain("not in the notification manifest")
  })

  it("never throws even if settings are malformed", async () => {
    // Write a garbage settings row directly
    const db = openDb()
    db.prepare(`INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('notifications', 'not json', datetime('now'))`).run()

    let report: any
    await expect((async () => {
      report = await notify({
        title: "T", body: "B", kind: "fail",
        toolCaller: async () => null,
        manifestOverride: [],
      })
    })()).resolves.toBeUndefined()
    expect(report.sent).toEqual([])
    expect(report.errors).toEqual([])
  })

  it("never throws when tool caller rejects for all channels", async () => {
    const report = await notify({
      title: "T", body: "B", kind: "fail",
      toolCaller: async () => { throw new Error("dead connection") },
      settingsOverride: baseSettings({
        channels: [{ connection: "composio", tool: "telegram_send_message", recipient: "42" }],
      }),
      manifestOverride: [telegramManifest],
    })
    expect(report.sent).toEqual([])
    expect(report.errors).toHaveLength(1)
  })
})

describe("settings persistence", () => {
  it("defaults when no row exists", () => {
    const s = getNotificationSettings()
    expect(s.channels).toEqual([])
    expect(s.triggerOn).toEqual({ fail: true })
  })

  it("round-trips a saved settings row", () => {
    saveNotificationSettings({
      channels: [{ connection: "composio", tool: "telegram_send_message", recipient: "42" }],
      triggerOn: { fail: false },
    })
    const s = getNotificationSettings()
    expect(s.channels).toHaveLength(1)
    expect(s.channels[0].recipient).toBe("42")
    expect(s.triggerOn.fail).toBe(false)
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

/**
 * Smoke tests for the notification settings routes — verify the router
 * recognises the new paths and that the underlying handlers (settings
 * persistence + manifest read) are wired together.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { matchRoute } from "../src/server/router.js"
import { openDb, closeDb } from "../src/db.js"
import { getNotificationSettings, saveNotificationSettings } from "../src/services/notify.js"

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

describe("notification settings routes", () => {
  it("matches the GET/PUT route", () => {
    const r = matchRoute("/api/settings/notifications")
    expect(r?.handler).toBe("notificationSettings")
  })

  it("matches the test-send route", () => {
    const r = matchRoute("/api/settings/notifications/test")
    expect(r?.handler).toBe("notificationSettingsTest")
  })

  it("does not match an unrelated path", () => {
    expect(matchRoute("/api/settings/other")).toBeNull()
  })
})

describe("notification settings round-trip", () => {
  it("saves and retrieves settings via the service layer", () => {
    saveNotificationSettings({
      channels: [
        { connection: "composio", tool: "telegram_send_message", recipient: "12345" },
      ],
      triggerOn: { fail: true },
    })
    const s = getNotificationSettings()
    expect(s.channels).toHaveLength(1)
    expect(s.channels[0].connection).toBe("composio")
  })
})

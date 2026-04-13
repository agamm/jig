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
  it("matches the connection connect route", () => {
    const r = matchRoute("/api/connections/workspace/connect")
    expect(r?.handler).toBe("connectConnection")
    expect(r?.params.name).toBe("workspace")
  })

  it("matches the examples route", () => {
    const r = matchRoute("/api/examples")
    expect(r?.handler).toBe("listExamples")
  })

  it("matches the add-example route", () => {
    const r = matchRoute("/api/examples/weekly-update/add")
    expect(r?.handler).toBe("addExample")
    expect(r?.params.id).toBe("weekly-update")
  })

  it("matches the GET/PUT route", () => {
    const r = matchRoute("/api/settings/notifications")
    expect(r?.handler).toBe("notificationSettings")
  })

  it("matches the test-send route", () => {
    const r = matchRoute("/api/settings/notifications/test")
    expect(r?.handler).toBe("notificationSettingsTest")
  })

  it("matches the local reset route", () => {
    const r = matchRoute("/api/settings/reset-local")
    expect(r?.handler).toBe("resetLocalState")
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

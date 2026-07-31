import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, openDb } from "../src/db.js"
import { maybeNotifyRunFailure } from "../src/services/run-failure-notify.js"

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

describe("maybeNotifyRunFailure", () => {
  it("sends notifications for failed persisted runs", async () => {
    const notifications: any[] = []
    const sent = await maybeNotifyRunFailure("weekly-update", 42, false, {
      getRun: () => ({
        id: 42,
        jig_id: "weekly-update",
        started_at: "2026-04-13 10:00:00",
        finished_at: "2026-04-13 10:00:05",
        status: "fail",
        duration_ms: 5000,
        error: "boom",
        output: null,
        params: null,
        steps: [],
      }),
      notify: async (payload) => {
        notifications.push(payload)
        return true
      },
    })

    expect(sent).toBe(true)
    expect(notifications).toHaveLength(1)
    expect(notifications[0].title).toBe('Jig "weekly-update" failed')
    expect(notifications[0].body).toContain("Error: boom")
  })

  it("skips dry runs and successful runs", async () => {
    const notifications: any[] = []

    const dryRunSent = await maybeNotifyRunFailure("weekly-update", 42, true, {
      getRun: () => null,
      notify: async (payload) => {
        notifications.push(payload)
        return false
      },
    })

    const successSent = await maybeNotifyRunFailure("weekly-update", 42, false, {
      getRun: () => ({
        id: 42,
        jig_id: "weekly-update",
        started_at: "2026-04-13 10:00:00",
        finished_at: "2026-04-13 10:00:05",
        status: "success",
        duration_ms: 5000,
        error: null,
        output: null,
        params: null,
        steps: [],
      }),
      notify: async (payload) => {
        notifications.push(payload)
        return false
      },
    })

    expect(dryRunSent).toBe(false)
    expect(successSent).toBe(false)
    expect(notifications).toHaveLength(0)
  })

  it("skips notifications for user-cancelled runs", async () => {
    const notifications: any[] = []

    const sent = await maybeNotifyRunFailure("weekly-update", 42, false, {
      getRun: () => ({
        id: 42,
        jig_id: "weekly-update",
        started_at: "2026-04-13 10:00:00",
        finished_at: "2026-04-13 10:00:05",
        status: "fail",
        duration_ms: 5000,
        error: "Cancelled by user",
        output: "Cancelled by user",
        params: null,
        steps: [],
      }),
      notify: async (payload) => {
        notifications.push(payload)
        return false
      },
    })

    expect(sent).toBe(false)
    expect(notifications).toHaveLength(0)
  })
})

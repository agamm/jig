import { describe, expect, it } from "bun:test"
import { maybeNotifyRunFailure } from "../src/services/run-failure-notify.js"

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
        return { sent: [{ channel: "Telegram", ok: true }], errors: [] }
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
        return { sent: [], errors: [] }
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
        return { sent: [], errors: [] }
      },
    })

    expect(dryRunSent).toBe(false)
    expect(successSent).toBe(false)
    expect(notifications).toHaveLength(0)
  })
})

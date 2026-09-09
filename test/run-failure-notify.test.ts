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
      cost_usd: null,
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
    // Nothing external recognised: the email points at the code.
    expect(notifications[0].body).toContain("Likely cause: the jig's code")
    expect(notifications[0].body).toContain("Next: bun run jig edit weekly-update --out=weekly-update.ts")
    // And carries a prompt a coding agent can take as-is.
    expect(notifications[0].body).toContain("For a coding agent, paste as-is:")
    expect(notifications[0].body).toContain("bun run jig debug failures --jig=weekly-update")
  })

  it("names the remedy in every email of an incident, from the failing step's own error", async () => {
    const bodies: string[] = []
    const failedRun = (id: number) => ({
      id,
      jig_id: "weekly-update",
      started_at: "2026-04-13 10:00:00",
      finished_at: "2026-04-13 10:00:05",
      status: "fail" as const,
      duration_ms: 5000,
      error: "Step failed",
      output: null,
      params: null,
      cost_usd: null,
      steps: [{
        id, run_id: id, seq: 1, label: "fetch issues", started_at: null, finished_at: null, duration_ms: null,
        output: null, status: "fail" as const, error: "401 Unauthorized", connections: JSON.stringify(["linear"]),
      }],
    })
    const deps = (id: number, now: number) => ({
      getRun: () => failedRun(id),
      notify: async (payload: any) => { bodies.push(payload.body); return true },
      now: () => now,
    })
    const t0 = Date.parse("2026-04-13T10:00:00Z")
    await maybeNotifyRunFailure("weekly-update", 1, false, deps(1, t0))
    await maybeNotifyRunFailure("weekly-update", 2, false, deps(2, t0 + 60_000))
    await maybeNotifyRunFailure("weekly-update", 3, false, deps(3, t0 + 25 * 60 * 60_000))

    expect(bodies).toHaveLength(3)
    for (const body of bodies) {
      expect(body).toContain("Likely cause: authorization expired or revoked")
      expect(body).toContain("bun run jig connect linear")
      expect(body).toContain("bun run jig debug failures --jig=weekly-update")
    }
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
      cost_usd: null,
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
      cost_usd: null,
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

/**
 * ctx.remind, a jig scheduling its own future wake-up.
 *
 * A cron trigger answers "run me every Monday"; a calendar trigger answers "run
 * me before each meeting". Neither answers "run me once, at 3pm on Thursday,
 * because of something that happened in an earlier run", which is what a
 * reminder, a follow-up, or a deferred retry actually needs.
 *
 * The scheduler consumes these on its existing minute tick (see
 * scheduler/reminder-tick.ts) and starts the jig with the due payloads in
 * ctx.params.reminders.
 */
import { isDryRun } from "./dryrun.js"

export interface PendingReminder {
  id: number
  key: string | null
  dueAt: Date
  payload: unknown
}

export interface JigReminders {
  /**
   * Wake this jig at `at`, carrying `payload`. With `options.key`, the reminder
   * replaces that key's pending one instead of stacking a duplicate, so a jig
   * that re-reads the same item every run reschedules rather than piling up.
   */
  remind(at: Date | number | string, payload?: unknown, options?: { key?: string }): Promise<void>
  /** Reminders scheduled but not yet fired, soonest first. */
  reminders(): Promise<PendingReminder[]>
  /** Cancel a pending reminder by key. True when one was actually cancelled. */
  cancelReminder(key: string): Promise<boolean>
}

/** Stops a runaway jig from scheduling wake-ups without bound. */
export const REMINDER_MAX_PENDING_PER_JIG = 1000

/** Accept a Date, epoch millis, or anything Date can parse (ISO strings). */
export function toDueAtMs(at: Date | number | string): number {
  const ms =
    at instanceof Date ? at.getTime()
    : typeof at === "number" ? at
    : Date.parse(at)
  if (!Number.isFinite(ms)) {
    throw new Error(
      `ctx.remind was given an unparseable time: ${JSON.stringify(at)}. ` +
      `Pass a Date, epoch milliseconds, or an ISO 8601 string.`
    )
  }
  return Math.round(ms)
}

export function createJigReminders(
  jigId: string | undefined,
  onDryRunWrite: (message: string) => void,
): JigReminders {
  function requireJigId(): string {
    if (!jigId) {
      throw new Error(
        "ctx.remind needs a jig identity and this run has none. " +
        "Run the jig by id (jig run <jig-id>, or from the dashboard) rather than by file path."
      )
    }
    return jigId
  }

  return {
    async remind(at, payload, options): Promise<void> {
      const id = requireJigId()
      const dueAt = toDueAtMs(at)
      const key = options?.key ?? null
      if (key != null && (typeof key !== "string" || key.trim() === "")) {
        throw new Error("ctx.remind options.key must be a non-empty string when provided")
      }
      const encoded = payload === undefined ? null : JSON.stringify(payload)
      if (payload !== undefined && encoded === undefined) {
        throw new Error("ctx.remind payload is not JSON-serializable")
      }

      if (isDryRun()) {
        onDryRunWrite(`[dry-run] would remind at ${new Date(dueAt).toISOString()}${key ? ` (key: ${key})` : ""}`)
        return
      }

      const { listPendingJigReminders, scheduleJigReminder } = await import("../db.js")
      // Only a NEW key can push past the cap, rescheduling an existing key
      // replaces its row, so a jig that keeps one reminder per to-do stays put.
      const pending = listPendingJigReminders(id)
      const replacesExisting = key != null && pending.some((r) => r.key === key)
      if (!replacesExisting && pending.length >= REMINDER_MAX_PENDING_PER_JIG) {
        throw new Error(
          `This jig already has ${REMINDER_MAX_PENDING_PER_JIG} pending reminders, the maximum. ` +
          `Pass options.key so repeat reminders for the same thing replace each other instead of accumulating.`
        )
      }
      scheduleJigReminder(id, dueAt, encoded, key)
    },

    async reminders(): Promise<PendingReminder[]> {
      const { listPendingJigReminders } = await import("../db.js")
      return listPendingJigReminders(requireJigId()).map((row) => ({
        id: row.id,
        key: row.key,
        dueAt: new Date(row.due_at),
        payload: decodeReminderPayload(row.payload),
      }))
    },

    async cancelReminder(key: string): Promise<boolean> {
      const id = requireJigId()
      if (typeof key !== "string" || key.trim() === "") {
        throw new Error("ctx.cancelReminder needs a non-empty key")
      }
      if (isDryRun()) {
        onDryRunWrite(`[dry-run] would cancel reminder ${key}`)
        return false
      }
      const { cancelJigReminder } = await import("../db.js")
      return cancelJigReminder(id, key)
    },
  }
}

/** Payloads are SDK-written JSON, but a hand-edited row must not break a run. */
export function decodeReminderPayload(raw: string | null): unknown {
  if (raw == null) return null
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

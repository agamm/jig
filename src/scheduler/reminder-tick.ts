/**
 * The reminder half of the scheduler tick.
 *
 * Same shape as calendar-tick.ts, and for the same reason: every dependency is
 * injected, so what fires, in what order, and what happens when one jig is busy
 * are all testable without a database, a clock, or a real minute passing.
 *
 * All of a jig's due reminders are delivered in ONE run. Firing them one per
 * tick would serialize a batch across as many minutes as there are reminders
 * (only one run per jig may be active), and would send the user N separate
 * emails where they expected one list.
 */
import type { JigReminderRow } from "../db.js"
import { decodeReminderPayload } from "../sdk/reminders.js"

export interface ReminderTickDeps {
  now: () => number
  listDue: (nowMs: number) => JigReminderRow[]
  /** False when the user has paused this jig's schedule. */
  isEnabled: (jigId: string) => boolean
  isRunning: (jigId: string) => boolean
  /** Claims reminders, returning the ids actually won. */
  markFired: (ids: number[], firedAt: number) => number[]
  /** Returning false means the run was refused; startBackgroundRun does not throw for that. */
  startRun: (jigId: string, params: Record<string, unknown>) => Promise<unknown>
  onError: (jigId: string, error: unknown) => void
}

export interface DeliveredReminder {
  key: string | null
  payload: unknown
  dueAt: string
}

/** Returns the number of jigs woken. */
export async function reminderTick(deps: ReminderTickDeps): Promise<number> {
  const now = deps.now()

  const byJig = new Map<string, JigReminderRow[]>()
  for (const row of deps.listDue(now)) {
    const bucket = byJig.get(row.jig_id)
    if (bucket) bucket.push(row)
    else byJig.set(row.jig_id, [row])
  }

  // Jigs are woken concurrently. Awaiting each in turn would let one slow jig
  // delay every other jig's reminders by the length of its run, and nothing
  // serializes across jigs anyway, only one run per jig is constrained.
  const results = await Promise.all([...byJig].map(async ([jigId, rows]) => {
    try {
      // A paused jig stays paused. The reminders are left pending rather than
      // consumed, so re-enabling delivers them instead of silently dropping
      // everything that came due while it was off.
      if (!deps.isEnabled(jigId)) return 0
      // Likewise when a run is already in flight: firing now would race it, and
      // the next tick is only a minute away.
      if (deps.isRunning(jigId)) return 0

      // Claim before running. If the process dies between the two, claim-first
      // costs one missed reminder; claim-after would resend the same reminder
      // on every tick until one run happened to survive.
      const claimed = new Set(deps.markFired(rows.map((r) => r.id), now))
      if (claimed.size === 0) return 0

      const reminders: DeliveredReminder[] = rows
        .filter((r) => claimed.has(r.id))
        .map((r) => ({
          key: r.key,
          payload: decodeReminderPayload(r.payload),
          dueAt: new Date(r.due_at).toISOString(),
        }))

      // startRun reports refusal by returning false rather than throwing (no
      // active version, a run that started in the meantime). The reminders are
      // already claimed at that point, so without this the user's "remind me
      // Thursday" would vanish with nothing logged.
      const started = await deps.startRun(jigId, { reminders })
      if (started === false) {
        deps.onError(jigId, new Error(
          `${reminders.length} reminder(s) were claimed but the run did not start; they will not fire again`,
        ))
        return 0
      }
      return 1
    } catch (error) {
      // One jig failing to start must not strand every other jig's reminders.
      deps.onError(jigId, error)
      return 0
    }
  }))

  return results.reduce<number>((sum, n) => sum + n, 0)
}

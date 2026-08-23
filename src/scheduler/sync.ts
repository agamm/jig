/**
 * Schedule sync — reconciles jig trigger configs with the schedules table.
 *
 * Reads each jig's active version from the store and parses its declared
 * trigger without executing module side effects.
 */
import { extractTriggerConfig } from "../domain/jig-source.js"
import { deleteJigInbox, deleteSchedule, getJigInbox, getSchedule, listAllSchedules, recordJigInbox, setScheduleError, upsertSchedule } from "../db.js"
import { schedulerTimeZone } from "../config/timezone.js"
import { computeNextRun } from "./cron-utils.js"
import { getActiveCode, listJigs } from "../services/jig-store.js"

function readTriggerConfig(jigId: string) {
  const code = getActiveCode(jigId)
  if (code == null) return { trigger: null, error: `Jig has no active version: ${jigId}` }
  try {
    return extractTriggerConfig(code)
  } catch (error: any) {
    return { trigger: null, error: `Failed to parse jig source: ${error?.message ?? String(error)}` }
  }
}

/**
 * Give an email-triggered jig its own AgentMail address, once.
 *
 * Runs on every sync cycle, so it must stay cheap and idempotent: the local row
 * short-circuits it after the first success, and AgentMail's `client_id` makes
 * even a repeat call return the existing inbox rather than a second one.
 */
async function ensureJigInbox(jigId: string): Promise<void> {
  if (getJigInbox(jigId)) return
  const { canSendAgentMail, createJigInbox } = await import("../services/agentmail.js")
  // Without a key there is nothing to provision against. Say so on the schedule
  // rather than throwing every minute, the fix is in Settings, not in the jig.
  if (!canSendAgentMail()) {
    setScheduleError(jigId, "Email trigger needs AgentMail, connect an inbox in Settings → Notifications.")
    return
  }
  const { inboxId, address } = await createJigInbox(jigId)
  recordJigInbox(jigId, inboxId, address)
  console.log(`[scheduler] ${jigId} receives mail at ${address}`)
}

/** Forget a jig's inbox mapping. The AgentMail inbox itself is left alone, so
 *  mail already delivered there stays retrievable and nothing is destroyed by a
 *  trigger edit. Cheap no-op when there was no mapping. */
function releaseJigInbox(jigId: string): void {
  if (getJigInbox(jigId)) deleteJigInbox(jigId)
}

export async function syncSchedules(): Promise<void> {
  const activeJigIds = new Set(listJigs().filter((j) => j.activeVersionId != null).map((j) => j.id))

  // Reconcile each discovered jig
  for (const jigId of activeJigIds) {
    const existing = getSchedule(jigId)
    const { trigger, error } = readTriggerConfig(jigId)

    if (error) {
      if (existing) setScheduleError(jigId, error)
      continue
    }

    // Any trigger other than email means the jig no longer receives mail. Drop
    // the inbox mapping: leaving it would keep routing inbound mail into a jig
    // that no longer reads it, and would keep ctx.email sending from an address
    // whose replies never reach the authoring agent.
    if (trigger?.type !== "email") releaseJigInbox(jigId)

    if (!trigger || trigger.type === "manual") {
      deleteSchedule(jigId)
      continue
    }

    if (trigger.type === "cron" && trigger.cron) {
      const cronExpr = trigger.cron
      const missedStrategy = trigger.missedStrategy ?? "catch-up"
      const timezone = schedulerTimeZone()

      // Only recompute next_run_at when the schedule definition changed. This
      // preserves already-due runs during regular sync, while migrating old UTC
      // schedules once because their stored timezone is null.
      const cronChanged = !existing || existing.cron_expr !== cronExpr
      const timezoneChanged = !existing || existing.timezone !== timezone
      const computedNextRunAt = cronChanged || timezoneChanged ? computeNextRun(cronExpr, timezone) : existing.next_run_at
      const nextRunAt = computedNextRunAt ?? existing?.next_run_at ?? null
      const syncError = computedNextRunAt === null ? `Invalid cron expression: ${cronExpr}` : null

      upsertSchedule(jigId, "cron", cronExpr, missedStrategy, nextRunAt, syncError, timezone)
      continue
    }

    if (trigger.type === "calendar") {
      // No next_run_at: the next fire time comes from the calendar, not from an
      // expression, so the tick recomputes it every minute from live events.
      upsertSchedule(jigId, "calendar", null, "skip", null, null)
      continue
    }

    if (trigger.type === "webhook") {
      upsertSchedule(jigId, "webhook", null, "skip", null, null)
      continue
    }

    if (trigger.type === "email") {
      // Like calendar and webhook, there is no next_run_at: arriving mail is
      // what fires it. The schedule row exists so the jig can be paused.
      upsertSchedule(jigId, "email", null, "skip", null, null)
      // Provisioning needs the network, so it must not block the rest of the
      // sync, a jig whose inbox is not up yet simply has no address to show
      // until the next cycle.
      void ensureJigInbox(jigId).catch((error) => {
        const message = (error as Error)?.message ?? String(error)
        console.error(`[scheduler] could not provision an inbox for ${jigId}: ${message}`)
        setScheduleError(jigId, `Email inbox setup failed: ${message}`)
      })
      continue
    }

    if (existing) setScheduleError(jigId, `Unsupported trigger type: ${trigger.type}`)
  }

  // Remove schedules for deleted jigs
  const allSchedules = listAllSchedules()
  for (const schedule of allSchedules) {
    if (!activeJigIds.has(schedule.jig_id)) {
      deleteSchedule(schedule.jig_id)
    }
  }
}

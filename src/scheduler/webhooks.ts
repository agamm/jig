/**
 * Webhook handler — fires a run when a webhook-triggered jig receives a POST.
 */
import { getSchedule } from "../db.js"
import { discoverAllJigs } from "../services/jig-api.js"
import { hasActiveRun } from "../services/run-store.js"
import { startScheduledRun } from "../services/scheduled-run.js"
import { validateWebhookToken } from "./webhook-auth.js"

export function handleWebhook(jigId: string, token: string | null): { status: number; body: unknown } {
  if (!discoverAllJigs().has(jigId)) {
    return { status: 404, body: { error: `Jig not found: ${jigId}` } }
  }

  if (!token || !validateWebhookToken(jigId, token)) {
    return { status: 401, body: { error: "Invalid or missing webhook token" } }
  }

  const schedule = getSchedule(jigId)
  if (!schedule || schedule.trigger_type !== "webhook") {
    return { status: 400, body: { error: `Jig ${jigId} is not configured for webhooks` } }
  }

  if (!schedule.enabled) {
    return { status: 403, body: { error: `Schedule for ${jigId} is disabled` } }
  }

  if (hasActiveRun()) {
    return { status: 409, body: { error: "A run is already in progress" } }
  }

  startScheduledRun(jigId).catch((e) => {
    console.error(`[webhook] failed to start ${jigId}:`, e?.message ?? e)
  })

  return { status: 202, body: { ok: true, jigId } }
}

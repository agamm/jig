/**
 * Jig routes that are not part of the version lifecycle (see versions.ts):
 * derived step listing, trigger editing, per-jig state, and deletion.
 */
import { cancelJigReminder, clearJigMemory, countJigMemory, deleteJigLocalState, deleteJigMemory, listJigMemory, listPendingJigReminders } from "../../db.js"
import { ApiError, apiJson } from "../http.js"
import { cronToText, replaceTriggerInSource, textToTrigger, textToTriggerLLM, triggerToSource } from "../../domain/triggers.js"
import { syncSchedules } from "../../scheduler/sync.js"
import { deriveSteps } from "../../derive-steps.js"
import {
  applyEffectiveModelToSteps,
  discoverAllJigs,
  extractModelInCode,
  getEffectiveModelContext,
} from "../../services/jig-api.js"
import {
  approvePending as approveJigPending,
  deleteJig as storeDeleteJig,
  getActiveCode as getJigActiveCode,
  getJigRow,
  writePending as storeWritePending,
} from "../../services/jig-store.js"
import { clearTrackedRunsForJig, hasActiveRunForJig } from "../../services/run-store.js"

export function ensureJigExists(id: string): void {
  if (!discoverAllJigs().has(id)) throw new ApiError(404, `Jig not found: ${id}`)
}

export async function handleGetSteps(id: string): Promise<Response> {
  ensureJigExists(id)
  const code = getJigActiveCode(id)
  if (!code) throw new ApiError(404, "Jig has no active version")
  const raw = await deriveSteps(id, code)
  // Relabel llm/agent chips against the live override chain — same rewrite
  // buildJigResponse does, so the chip on the steps tab reflects the
  // dashboard's per-step picks without needing the user to edit code.
  const { jigEffectiveModel, stepOverrides } = getEffectiveModelContext(id, extractModelInCode(code))
  const steps = applyEffectiveModelToSteps(raw as any, stepOverrides, jigEffectiveModel)
  return apiJson("getSteps", { steps })
}

export async function handleUpdateTrigger(id: string, body: any): Promise<Response> {
  const triggerText = body?.trigger as string
  if (!triggerText) throw new ApiError(400, "Missing trigger text")

  ensureJigExists(id)
  const code = getJigActiveCode(id)
  if (!code) throw new ApiError(404, "Jig has no active version")

  const trigger = textToTrigger(triggerText) ?? await textToTriggerLLM(triggerText)
  if (!trigger) throw new ApiError(400, `Could not parse trigger: "${triggerText}"`)
  if (trigger.type !== "cron" && trigger.type !== "manual" && trigger.type !== "webhook") {
    throw new ApiError(400, `Unsupported trigger type: "${trigger.type}". Expected cron, manual, or webhook.`)
  }

  const updated = replaceTriggerInSource(code, triggerToSource(trigger))
  if (!updated) throw new ApiError(400, "Could not find trigger in source file")

  // Trigger edits are metadata — they don't need an approval gate. Write a new
  // version and promote it to active in one go via the store.
  storeWritePending({
    jigId: id,
    code: updated,
    author: "cli",
    message: `update trigger`,
    prompt: `Update trigger to: ${triggerText}`,
  })
  approveJigPending(id)

  const newTriggerText = trigger.type === "cron" && trigger.cron ? cronToText(trigger.cron)
    : trigger.type === "manual" ? "Manual"
    : trigger.type === "webhook" ? "Webhook"
    : triggerText

  const result = { ok: true, trigger: newTriggerText } as {
    ok: true
    trigger: string
    warning?: string
  }
  if ("approximate" in trigger && trigger.approximate) {
    result.warning = ("note" in trigger && typeof trigger.note === "string" && trigger.note)
      || "This is an approximation — cron cannot express the exact schedule"
  }
  await syncSchedules()
  return apiJson("updateTrigger", result)
}

export async function handleDeleteJig(id: string): Promise<Response> {
  if (!getJigRow(id)) throw new ApiError(404, `Jig not found: ${id}`)
  if (hasActiveRunForJig(id)) {
    throw new ApiError(409, "Cannot delete a jig while it is running")
  }

  storeDeleteJig(id)
  deleteJigLocalState(id)
  clearTrackedRunsForJig(id)

  return apiJson("deleteJig", { ok: true, jigId: id })
}


/**
 * Read or clear one jig's ctx.memory.
 *
 * A jig that remembers things is only trustworthy if the user can see what it
 * remembers and delete an entry that is wrong, a to-do list you cannot correct
 * is worse than none. DELETE takes ?key= to remove one entry, or clears all
 * when no key is given.
 */
export async function handleJigMemory(id: string, method: string, key: string | null): Promise<Response> {
  ensureJigExists(id)
  if (method !== "GET" && method !== "DELETE") throw new ApiError(405, "Method not allowed")

  if (method === "DELETE") {
    if (key) {
      return apiJson("jigMemory", { ok: true as const, deleted: deleteJigMemory(id, key) })
    }
    const deleted = countJigMemory(id)
    clearJigMemory(id)
    return apiJson("jigMemory", { ok: true as const, deleted })
  }

  return apiJson("jigMemory", listJigMemory(id).map((row) => ({
    key: row.key,
    value: row.value,
    updatedAt: new Date(row.updated_at).toISOString(),
  })))
}

/** Read pending ctx.remind wake-ups, or cancel one by ?key=. */
export async function handleJigReminders(id: string, method: string, key: string | null): Promise<Response> {
  ensureJigExists(id)
  if (method !== "GET" && method !== "DELETE") throw new ApiError(405, "Method not allowed")

  if (method === "DELETE") {
    // Keyless reminders have no stable handle to cancel by; that is the
    // trade-off of omitting a key, and the error should say so rather than
    // silently cancelling something else.
    if (!key) throw new ApiError(400, "Pass ?key= to cancel a reminder. Reminders scheduled without a key cannot be cancelled individually.")
    return apiJson("jigReminders", { ok: true as const, cancelled: cancelJigReminder(id, key) })
  }

  return apiJson("jigReminders", listPendingJigReminders(id).map((row) => ({
    id: row.id,
    key: row.key,
    dueAt: new Date(row.due_at).toISOString(),
    payload: row.payload,
  })))
}

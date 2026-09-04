import type { JigData, JigRun } from "../../shared/api.js"
import { getJigInbox, getJigRuns, getLastRun, getSchedule, listJigMemory, listPendingJigReminders } from "../db.js"
import { formatDuration } from "../utils.js"
import { prettifyId } from "../domain/jig-source.js"
import { getActiveRunStatusForJig } from "./run-store.js"
import { webhookToken } from "../scheduler/webhook-auth.js"
import { introspectJig } from "./introspect-jig.js"
import { listJigs as storeListJigs } from "./jig-store.js"
import { publicUrl } from "../config/runtime.js"

function deriveStatus(jigId: string): "healthy" | "attention" | "failed" {
  try {
    const lastRun = getLastRun(jigId)
    if (!lastRun) return "attention"
    return lastRun.status === "success" ? "healthy" : lastRun.status === "fail" ? "failed" : "attention"
  } catch {
    return "attention"
  }
}

function formatRuns(runs: ReturnType<typeof getJigRuns>): JigRun[] {
  return runs.filter((r) => r.status !== "running").map((r) => ({
    date: r.started_at,
    duration: r.duration_ms ? formatDuration(r.duration_ms) : "—",
    status: (r.status === "fail" ? "fail" : "success") as "success" | "fail",
    cost: "",
    output: r.output ?? undefined,
    error: r.error ?? undefined,
    steps: r.steps.map((s) => ({
      label: s.label,
      time: s.duration_ms ? formatDuration(s.duration_ms) : "—",
      status: s.status,
      cost: undefined,
      tag: undefined,
      healed: s.status === "healed",
      output: s.output ?? undefined,
      error: s.error ?? undefined,
    })),
  }))
}

export async function buildJigResponse(
  id: string,
  runLimit: number,
  includeSteps = false,
  /**
   * Include the jig's stored state (ctx.memory, pending ctx.remind wake-ups).
   * Off by default because the list endpoint builds one of these per jig, and a
   * jig may hold up to 1000 keys of 64KB each. That is a detail-view payload,
   * and the dashboard polls the list.
   */
  includeState = false,
): Promise<JigData> {
  const jig = await introspectJig(id, { includeSteps })

  let runs: ReturnType<typeof getJigRuns> = []
  try {
    runs = getJigRuns(id, runLimit)
  } catch {}

  const recentDurations = runs.slice(0, 7).map((r) => r.duration_ms ?? 0).reverse()
  const maxDur = Math.max(...recentDurations, 1)
  const sparkline = recentDurations.map((d) => Math.round((d / maxDur) * 100))

  const scheduleRow = getSchedule(id)
  const schedule = scheduleRow ? (() => {
    const port = parseInt(process.env.JIG_API_PORT ?? process.env.PORT ?? "3141")
    // In service mode (Railway/Render/Fly), webhooks are hit from the public
    // internet — must use the deployed HTTPS URL. Localhost only works in dev.
    const base = publicUrl() ?? `http://localhost:${port}`
    const webhookUrl = scheduleRow.trigger_type === "webhook"
      ? `${base}/api/webhooks/${id}?token=${webhookToken(id)}`
      : undefined
    // Undefined until the scheduler has provisioned it, the dashboard shows
    // "setting up" rather than an address that does not exist yet.
    const inboxAddress = scheduleRow.trigger_type === "email"
      ? getJigInbox(id)?.address
      : undefined
    return {
      triggerType: scheduleRow.trigger_type,
      cronExpr: scheduleRow.cron_expr,
      timezone: scheduleRow.timezone,
      missedStrategy: scheduleRow.missed_strategy,
      nextRunAt: scheduleRow.next_run_at ? new Date(scheduleRow.next_run_at * 1000).toISOString() : null,
      lastRunAt: scheduleRow.last_run_at ? new Date(scheduleRow.last_run_at * 1000).toISOString() : null,
      enabled: scheduleRow.enabled === 1,
      error: scheduleRow.error,
      webhookUrl,
      inboxAddress,
    }
  })() : undefined

  const activeRun = getActiveRunStatusForJig(id)

  return {
    id,
    name: prettifyId(id),
    trigger: jig.trigger,
    status: deriveStatus(id),
    running: activeRun.active && !activeRun.dryRun,
    sparkline,
    steps: jig.steps,
    code: jig.code,
    runs: formatRuns(runs),
    schedule,
    settings: {
      trigger: jig.trigger,
      connections: jig.connections,
      tools: jig.tools,
      permissions: jig.permissions,
    },
    modelInCode: jig.modelInCode ?? null,
    costMonth: "",
    costLifetime: "",
    // A jig's own state, so the user can see and correct what it remembers.
    ...(includeState ? {
      memory: listJigMemory(id).map((row) => ({
        key: row.key,
        value: prettyJson(row.value),
        updatedAt: new Date(row.updated_at).toISOString(),
      })),
      reminders: listPendingJigReminders(id).map((row) => ({
        id: row.id,
        key: row.key,
        dueAt: new Date(row.due_at).toISOString(),
        payload: row.payload,
      })),
    } : {}),
  }
}

/** Values are stored as compact JSON; expand them so the dashboard is readable.
 *  A value written outside the SDK may not be JSON, show it as-is. */
function prettyJson(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

export async function buildDraftJigResponse(
  id: string,
  code: string,
  filePath: string,
  includeSteps = true,
): Promise<JigData> {
  const jig = await introspectJig(id, {
    includeSteps,
    filePathOverride: filePath,
    codeOverride: code,
  })

  return {
    id,
    name: prettifyId(id),
    trigger: jig.trigger,
    status: "attention",
    running: false,
    sparkline: [],
    steps: jig.steps,
    code: jig.code,
    runs: [],
    settings: {
      trigger: jig.trigger,
      connections: jig.connections,
      tools: jig.tools,
      permissions: jig.permissions,
    },
    modelInCode: jig.modelInCode ?? null,
    costMonth: "",
    costLifetime: "",
  }
}

export function discoverAllJigs(): Map<string, string[]> {
  const map = new Map<string, string[]>()
  for (const jig of storeListJigs()) {
    if (jig.activeVersionId != null) map.set(jig.id, [])
  }
  return map
}

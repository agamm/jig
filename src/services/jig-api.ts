import type { JigData, JigRun } from "../../shared/api.js"
import { JIGS_DIR } from "../config/paths.js"
import { getJigRuns, getLastRun, getSchedule } from "../db.js"
import { discoverJigs } from "../discover.js"
import { formatDuration } from "../utils.js"
import { prettifyId } from "../domain/jig-source.js"
import { getActiveRunStatusForJig } from "./run-store.js"
import { webhookToken } from "../scheduler/webhook-auth.js"
import { introspectJig } from "./introspect-jig.js"

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
    steps: r.steps.map((s) => ({
      label: s.label,
      time: s.duration_ms ? formatDuration(s.duration_ms) : "—",
      cost: undefined,
      tag: undefined,
      healed: s.status === "healed",
      output: s.output ?? undefined,
    })),
  }))
}

export async function buildJigResponse(
  id: string,
  runLimit: number,
  includeSteps = false,
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
    const webhookUrl = scheduleRow.trigger_type === "webhook"
      ? `http://localhost:${port}/api/webhooks/${id}?token=${webhookToken(id)}`
      : undefined
    return {
      triggerType: scheduleRow.trigger_type,
      cronExpr: scheduleRow.cron_expr,
      missedStrategy: scheduleRow.missed_strategy,
      nextRunAt: scheduleRow.next_run_at ? new Date(scheduleRow.next_run_at * 1000).toISOString() : null,
      lastRunAt: scheduleRow.last_run_at ? new Date(scheduleRow.last_run_at * 1000).toISOString() : null,
      enabled: scheduleRow.enabled === 1,
      error: scheduleRow.error,
      webhookUrl,
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
    costMonth: "",
    costLifetime: "",
  }
}

export function discoverAllJigs(): Map<string, string[]> {
  return discoverJigs(JIGS_DIR)
}

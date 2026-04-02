import { readFileSync } from "fs"
import type { JigData, JigRun, JigTool } from "../../shared/api.js"
import { JIGS_DIR } from "../config/paths.js"
import { getJigRuns, getLastRun, getSchedule } from "../db.js"
import { discoverJigs } from "../discover.js"
import { parseStepsFromSource } from "../derive-steps.js"
import { formatDuration } from "../utils.js"
import { extractConnections, extractParams, extractTrigger, getJigFilePath, prettifyId } from "../domain/jig-source.js"
import { getActiveRunStatusForJig } from "./run-store.js"
import { webhookToken } from "../scheduler/webhook-auth.js"

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

function dedupeTools(tools: JigTool[]): JigTool[] {
  return [...new Map(tools.map((tool) => [`${tool.connection}:${tool.name}`, tool])).values()]
}

export async function buildJigResponse(
  id: string,
  runLimit: number,
  includeSteps = false,
): Promise<JigData> {
  const filePath = getJigFilePath(id)
  let code = ""
  try {
    if (filePath) code = readFileSync(filePath, "utf-8")
  } catch {}

  let runs: ReturnType<typeof getJigRuns> = []
  try {
    runs = getJigRuns(id, runLimit)
  } catch {}

  const recentDurations = runs.slice(0, 7).map((r) => r.duration_ms ?? 0).reverse()
  const maxDur = Math.max(...recentDurations, 1)
  const sparkline = recentDurations.map((d) => Math.round((d / maxDur) * 100))

  let params: Record<string, string> = {}
  let trigger = code ? extractTrigger(code) : ""
  let tools: JigTool[] = []
  let steps: JigData["steps"] = []
  if (filePath) {
    try {
      const mod = await import(`${filePath}?_t=${Date.now()}_${Math.random().toString(36).slice(2)}`)
      const def = mod.default
      if (def?.options) params = def.options.params ?? {}
      if (def?.options?.tools?.length) {
        tools = dedupeTools(def.options.tools.map((tool: any) => ({
          connection: tool._serverName,
          name: tool._toolName,
          readOnly: tool._readOnly === true,
        })))
      }
      if (includeSteps && code) {
        const { deriveSteps } = await import("../derive-steps.js")
        steps = await deriveSteps(id, code)
      }
    } catch {
      params = extractParams(code)
      trigger = extractTrigger(code)
    }
  }

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
  const connections = tools.length > 0
    ? [...new Set(tools.map((tool) => tool.connection))]
    : extractConnections(code)

  // Detect legacy jigs (have a handler but no block-scoped ctx.step calls)
  const needsUpgrade = code && /export\s+default/.test(code) && parseStepsFromSource(code).length === 0
    ? true : undefined

  return {
    id,
    name: prettifyId(id),
    trigger,
    status: deriveStatus(id),
    running: activeRun.active && !activeRun.dryRun,
    sparkline,
    steps,
    code,
    runs: formatRuns(runs),
    params,
    needsUpgrade,
    schedule,
    settings: {
      trigger,
      connections,
      tools,
      permissions: [],
    },
    costMonth: "",
    costLifetime: "",
  }
}

export function discoverAllJigs(): Map<string, string[]> {
  return discoverJigs(JIGS_DIR)
}

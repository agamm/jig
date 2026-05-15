import type { JigData, JigRun } from "../../shared/api.js"
import { getJigRuns, getLastRun, getSchedule } from "../db.js"
import { formatDuration } from "../utils.js"
import { prettifyId } from "../domain/jig-source.js"
import { getActiveRunStatusForJig } from "./run-store.js"
import { webhookToken } from "../scheduler/webhook-auth.js"
import { introspectJig } from "./introspect-jig.js"
import { getJigRow, getStepModelOverrides, listJigs as storeListJigs } from "./jig-store.js"
import { getMainModel } from "../config/models.js"
import type { JigStep, JigStepTool } from "../../shared/api.js"
import { publicUrl } from "../config/runtime.js"

/**
 * Replace the model label in `llm.llm(<model>)` / `llm.agent(<model>)` tool
 * names with the effective model for that step, so the dashboard chip reflects
 * the live precedence chain (dashboard-step > code-step > dashboard-jig >
 * code-jig > global default) — not the regex-derived placeholder cached at
 * parse time.
 *
 * The parser already captures the code-declared model (or hardcodes the global
 * default if absent); we re-render it here against the current overrides.
 */
function applyEffectiveModelToSteps(
  steps: JigStep[],
  stepOverrides: Record<string, string>,
  jigEffectiveModel: string,
): JigStep[] {
  const shortLabel = (id: string) => id.split("/").pop() ?? id
  return steps.map((step) => {
    const tools = step.tools
    if (!tools || tools.length === 0) return step
    const overrideForStep = stepOverrides[String(step.num)]
    const rewritten: JigStepTool[] = tools.map((tool) => {
      if (tool.connection !== "llm") return tool
      const match = tool.name.match(/^(llm|agent)\(/)
      if (!match) return tool
      const kind = match[1]
      // Per-step dashboard override wins; otherwise show the jig effective model.
      const effective = overrideForStep ?? jigEffectiveModel
      return { ...tool, name: `${kind}(${shortLabel(effective)})` }
    })
    return { ...step, tools: rewritten }
  })
}

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
    // In service mode (Railway/Render/Fly), webhooks are hit from the public
    // internet — must use the deployed HTTPS URL. Localhost only works in dev.
    const base = publicUrl() ?? `http://localhost:${port}`
    const webhookUrl = scheduleRow.trigger_type === "webhook"
      ? `${base}/api/webhooks/${id}?token=${webhookToken(id)}`
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
    }
  })() : undefined

  const activeRun = getActiveRunStatusForJig(id)

  const row = getJigRow(id)
  const stepOverrides = getStepModelOverrides(id)
  const jigEffectiveModel = row?.model_override ?? jig.modelInCode ?? getMainModel()
  const steps = applyEffectiveModelToSteps(jig.steps, stepOverrides, jigEffectiveModel)

  return {
    id,
    name: prettifyId(id),
    trigger: jig.trigger,
    status: deriveStatus(id),
    running: activeRun.active && !activeRun.dryRun,
    sparkline,
    steps,
    code: jig.code,
    runs: formatRuns(runs),
    schedule,
    settings: {
      trigger: jig.trigger,
      connections: jig.connections,
      tools: jig.tools,
      permissions: jig.permissions,
    },
    modelOverride: row?.model_override ?? null,
    modelInCode: jig.modelInCode ?? null,
    stepModelOverrides: stepOverrides,
    costMonth: "",
    costLifetime: "",
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

  const draftEffectiveModel = jig.modelInCode ?? getMainModel()
  const draftSteps = applyEffectiveModelToSteps(jig.steps, {}, draftEffectiveModel)

  return {
    id,
    name: prettifyId(id),
    trigger: jig.trigger,
    status: "attention",
    running: false,
    sparkline: [],
    steps: draftSteps,
    code: jig.code,
    runs: [],
    settings: {
      trigger: jig.trigger,
      connections: jig.connections,
      tools: jig.tools,
      permissions: jig.permissions,
    },
    modelOverride: null,
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

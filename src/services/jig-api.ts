import { readFileSync } from "fs"
import type { JigData, JigRun, JigTool } from "../../shared/api.js"
import { JIGS_DIR } from "../config/paths.js"
import { getJigRuns, getLastRun, getStepCache } from "../db.js"
import { discoverJigs } from "../discover.js"
import { isUsableCachedSteps } from "../derive-steps.js"
import { formatDuration } from "../utils.js"
import { extractConnections, extractParams, extractTrigger, getJigFilePath, prettifyId } from "../domain/jig-source.js"
import { getActiveRunStatus } from "./run-store.js"

function deriveStatus(jigId: string, entity?: string): "healthy" | "attention" | "failed" {
  try {
    const lastRun = getLastRun(jigId, entity)
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
  entities: string[],
  runLimit: number,
  includeSteps = false,
  selectedEntity?: string
): Promise<JigData> {
  const entity = selectedEntity ?? null
  const filePath = getJigFilePath(id, entity ?? undefined)
  let code = ""
  try {
    if (filePath) code = readFileSync(filePath, "utf-8")
  } catch {}

  let runs: ReturnType<typeof getJigRuns> = []
  try {
    runs = getJigRuns(id, entity ?? undefined, runLimit)
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
      const mod = await import(`${filePath}?_t=${Date.now()}`)
      const def = mod.default
      if (def?.options) params = def.options.params ?? {}
      if (def?.options?.tools?.length) {
        tools = dedupeTools(def.options.tools.map((tool: any) => ({
          connection: tool._serverName,
          name: tool._toolName,
          readOnly: tool._readOnly === true,
        })))
      }
      if (includeSteps && def?.handler && code) {
        const hasher = new Bun.CryptoHasher("sha256")
        hasher.update(code)
        const cached = getStepCache(id, entity, hasher.digest("hex"))
        if (cached && isUsableCachedSteps(cached)) steps = cached
      }
    } catch {
      params = extractParams(code)
      trigger = extractTrigger(code)
    }
  }

  const activeRun = getActiveRunStatus()
  const connections = tools.length > 0
    ? [...new Set(tools.map((tool) => tool.connection))]
    : extractConnections(code)
  const isGroupedChild = entity !== null
  const uiId = isGroupedChild ? `${id}::${entity}` : id

  return {
    id: uiId,
    sourceId: id,
    entity,
    groupId: isGroupedChild ? id : null,
    groupName: isGroupedChild ? prettifyId(id) : null,
    name: prettifyId(entity ?? id),
    trigger,
    status: deriveStatus(id, entity ?? undefined),
    running:
      activeRun.active &&
      activeRun.jigId === id &&
      (activeRun.entity ?? null) === entity &&
      !activeRun.dryRun,
    sparkline,
    steps,
    code,
    runs: formatRuns(runs),
    params,
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

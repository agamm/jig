import { readFileSync } from "fs"
import type { JigDto, JigEntityDto, JigRunDto } from "../../shared/api.js"
import { JIGS_DIR } from "../config/paths.js"
import { getJigRuns, getLastRun, getStepCache } from "../db.js"
import { discoverJigs } from "../discover.js"
import { formatDuration } from "../utils.js"
import { extractConnections, extractParams, extractTrigger, getJigFilePath, prettifyId } from "../domain/jig-source.js"
import { getActiveRunStatus } from "./run-store.js"

function deriveStatus(jigId: string): "healthy" | "attention" | "failed" {
  try {
    const lastRun = getLastRun(jigId)
    if (!lastRun) return "attention"
    return lastRun.status === "success" ? "healthy" : lastRun.status === "fail" ? "failed" : "attention"
  } catch {
    return "attention"
  }
}

function buildEntityList(jigId: string, entities: string[]): JigEntityDto[] {
  return entities.map((name) => {
    const last = getLastRun(jigId, name)
    return {
      name,
      lastRun: last?.finished_at ?? last?.started_at ?? "",
      status: (last?.status === "fail" ? "fail" : "success") as "success" | "fail",
    }
  })
}

function formatRuns(runs: ReturnType<typeof getJigRuns>): JigRunDto[] {
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

export async function buildJigResponse(id: string, entities: string[], runLimit: number, includeSteps = false): Promise<JigDto> {
  const grouped = entities.length > 0
  const filePath = getJigFilePath(id, grouped ? entities[0] : undefined)
  let code = ""
  try {
    if (filePath) code = readFileSync(filePath, "utf-8")
  } catch {}

  const entity = grouped ? entities[0] : null
  let runs: ReturnType<typeof getJigRuns> = []
  try {
    runs = getJigRuns(id, undefined, runLimit)
  } catch {}

  const recentDurations = runs.slice(0, 7).map((r) => r.duration_ms ?? 0).reverse()
  const maxDur = Math.max(...recentDurations, 1)
  const sparkline = recentDurations.map((d) => Math.round((d / maxDur) * 100))

  let params: Record<string, string> = {}
  let trigger = code ? extractTrigger(code) : ""
  let steps: JigDto["steps"] = []
  if (filePath) {
    try {
      const mod = await import(`${filePath}?_t=${Date.now()}`)
      const def = mod.default
      if (def?.options) params = def.options.params ?? {}
      if (includeSteps && def?.handler && code) {
        const hasher = new Bun.CryptoHasher("sha256")
        hasher.update(code)
        const cached = getStepCache(id, entity, hasher.digest("hex"))
        if (cached) steps = cached
      }
    } catch {
      params = extractParams(code)
      trigger = extractTrigger(code)
    }
  }

  const activeRun = getActiveRunStatus()

  return {
    id,
    name: prettifyId(id),
    trigger,
    status: deriveStatus(id),
    running: activeRun.active && activeRun.jigId === id && !activeRun.dryRun,
    grouped,
    entityCount: grouped ? entities.length : undefined,
    entities: grouped ? buildEntityList(id, entities) : undefined,
    sparkline,
    steps,
    code: grouped ? "" : code,
    runs: formatRuns(runs),
    params,
    settings: {
      trigger,
      connections: extractConnections(code),
      permissions: [],
    },
    costMonth: "",
    costLifetime: "",
  }
}

export function discoverAllJigs(): Map<string, string[]> {
  return discoverJigs(JIGS_DIR)
}

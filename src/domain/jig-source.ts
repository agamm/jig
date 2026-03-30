import { existsSync } from "fs"
import { join } from "path"
import { JIGS_DIR } from "../config/paths.js"
import { discoverJigs } from "../discover.js"
import { cronToText } from "./triggers.js"
import { isValidJigId } from "./jig-id.js"

export function prettifyId(id: string): string {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export function extractParams(code: string): Record<string, string> {
  const m = code.match(/params\s*:\s*\{([^}]*(?:\{[^}]*\}[^}]*)*)\}/s)
  if (!m) return {}
  const params: Record<string, string> = {}
  const entries = m[1].matchAll(/(\w+)\s*:\s*["'`]([^"'`]*)["'`]/g)
  for (const e of entries) params[e[1]] = e[2]
  return params
}

export function extractConnections(code: string): string[] {
  const matches = code.matchAll(/from\s+["'].*?\/connections\/(\w+)\.(?:js|ts)["']/g)
  return [...new Set([...matches].map((m) => m[1]))]
}

export function extractTrigger(code: string): string {
  const m = code.match(/trigger\s*:\s*\{[^}]*type\s*:\s*["'](\w+)["'][^}]*\}/)
  if (!m) return ""
  const type = m[1]
  if (type === "cron") {
    const cronMatch = m[0].match(/cron\s*:\s*["']([^"']+)["']/)
    return cronMatch ? cronToText(cronMatch[1]) : "Scheduled"
  }
  if (type === "interval") {
    const minMatch = m[0].match(/minutes\s*:\s*(\d+)/)
    return minMatch ? `Every ${minMatch[1]}m` : "Interval"
  }
  if (type === "event") {
    const srcMatch = m[0].match(/source\s*:\s*["']([^"']+)["']/)
    return srcMatch ? `On ${srcMatch[1]}` : "Event"
  }
  if (type === "manual") return "Manual"
  if (type === "webhook") return "Webhook"
  return ""
}

type JigEntitySelectionOptions = {
  defaultToFirstGrouped?: boolean
}

export type JigEntitySelection =
  | { ok: true; entity?: string }
  | { ok: false; reason: "invalid" | "missing" | "not-found" | "unexpected"; available?: string[] }

export function selectJigEntity(
  entities: string[],
  requestedEntity?: string | null,
  options: JigEntitySelectionOptions = {}
): JigEntitySelection {
  if (requestedEntity && !isValidJigId(requestedEntity)) {
    return { ok: false, reason: "invalid" }
  }

  if (entities.length === 0) {
    return requestedEntity
      ? { ok: false, reason: "unexpected" }
      : { ok: true }
  }

  if (requestedEntity) {
    return entities.includes(requestedEntity)
      ? { ok: true, entity: requestedEntity }
      : { ok: false, reason: "not-found", available: entities }
  }

  if (options.defaultToFirstGrouped) {
    return { ok: true, entity: entities[0] }
  }

  return { ok: false, reason: "missing", available: entities }
}

export function getJigRelativePath(jigId: string, entity?: string | null): string | null {
  if (!isValidJigId(jigId)) return null
  if (entity && !isValidJigId(entity)) return null
  return entity ? `${jigId}/${entity}.ts` : `${jigId}.ts`
}

export function resolveJigPath(jigId: string, entity?: string): string {
  if (entity) return join(JIGS_DIR, jigId, `${entity}.ts`)
  return join(JIGS_DIR, `${jigId}.ts`)
}

export function getJigFilePath(id: string, entity?: string): string | null {
  if (entity) {
    const relPath = getJigRelativePath(id, entity)
    if (!relPath) return null
    const p = join(JIGS_DIR, relPath)
    return existsSync(p) ? p : null
  }
  const relPath = getJigRelativePath(id)
  if (!relPath) return null
  const single = join(JIGS_DIR, relPath)
  if (existsSync(single)) return single
  const dir = join(JIGS_DIR, id)
  if (existsSync(dir)) {
    const jigs = discoverJigs(JIGS_DIR)
    const entities = jigs.get(id)
    if (entities && entities.length > 0) {
      return join(dir, `${entities[0]}.ts`)
    }
  }
  return null
}

import { existsSync } from "fs"
import { join } from "path"
import { JIGS_DIR } from "../config/paths.js"
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

export function getJigRelativePath(jigId: string): string | null {
  if (!isValidJigId(jigId)) return null
  return `${jigId}.ts`
}

export function resolveJigPath(jigId: string): string {
  return join(JIGS_DIR, `${jigId}.ts`)
}

export function getJigFilePath(id: string): string | null {
  if (!isValidJigId(id)) return null
  const p = join(JIGS_DIR, `${id}.ts`)
  return existsSync(p) ? p : null
}

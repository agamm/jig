import { existsSync } from "fs"
import { join } from "path"
import { JIGS_DIR } from "../config/paths.js"
import { cronToText } from "./triggers.js"
import { isValidJigId } from "./jig-id.js"
import { getImportedServers } from "./source-analysis.js"

export interface TriggerConfig {
  type: "cron" | "manual" | "webhook"
  cron?: string
  missedStrategy?: "catch-up" | "skip"
}

export interface TriggerParseResult {
  trigger: TriggerConfig | null
  error?: string
}

function extractTriggerObject(code: string): string | null {
  const match = /trigger\s*:/.exec(code)
  if (!match) return null

  let i = match.index + match[0].length
  while (i < code.length && /\s/.test(code[i])) i++
  if (code[i] !== "{") return null

  const start = i
  let depth = 0
  let quote: string | null = null
  let escaped = false

  for (; i < code.length; i++) {
    const ch = code[i]
    if (quote) {
      if (escaped) {
        escaped = false
      } else if (ch === "\\") {
        escaped = true
      } else if (ch === quote) {
        quote = null
      }
      continue
    }

    if (ch === '"' || ch === "'" || ch === "`") {
      quote = ch
      continue
    }
    if (ch === "{") depth++
    if (ch === "}") {
      depth--
      if (depth === 0) return code.slice(start, i + 1)
    }
  }

  return null
}

export function extractTriggerConfig(code: string): TriggerParseResult {
  const objectText = extractTriggerObject(code)
  if (!objectText) return { trigger: null }

  const typeMatch = objectText.match(/type\s*:\s*["'`]([a-z]+)["'`]/i)
  if (!typeMatch) {
    return { trigger: null, error: "Unable to read trigger type from source" }
  }

  const type = typeMatch[1].toLowerCase()
  const missedStrategyMatch = objectText.match(/missedStrategy\s*:\s*["'`](catch-up|skip)["'`]/)
  const missedStrategy = missedStrategyMatch?.[1] as "catch-up" | "skip" | undefined

  if (type === "manual" || type === "webhook") {
    return { trigger: { type, missedStrategy } as TriggerConfig }
  }

  if (type === "cron") {
    const cronMatch = objectText.match(/cron\s*:\s*["'`]([^"'`]+)["'`]/)
    if (!cronMatch) {
      return { trigger: null, error: "Cron trigger must use a literal cron string" }
    }
    return { trigger: { type: "cron", cron: cronMatch[1], missedStrategy } }
  }

  return { trigger: null, error: `Unsupported trigger type: ${type}. Expected: cron, manual, webhook` }
}

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
  return getImportedServers(code)
}

export function extractTrigger(code: string): string {
  const { trigger } = extractTriggerConfig(code)
  if (!trigger) return ""
  const type = trigger.type
  if (type === "cron") {
    return trigger.cron ? cronToText(trigger.cron) : "Scheduled"
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

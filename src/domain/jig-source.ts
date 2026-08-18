import { cronToText } from "./triggers.js"
import { getImportedServers } from "./source-analysis.js"

export interface TriggerConfig {
  type: "cron" | "manual" | "webhook" | "calendar"
  cron?: string
  /** Calendar triggers only: lead time in minutes before the event starts. */
  minutesBefore?: number
  missedStrategy?: "catch-up" | "skip"
}

/**
 * A calendar trigger is served by the scheduler reading the user's calendar
 * over composio, so the connection is a hard requirement of the trigger itself
 * rather than of anything the jig imports. Declaring it here means every
 * surface that already reports connections picks it up: the run preflight, the
 * dashboard's connection list, and a connection's used-by list.
 */
export const CALENDAR_TRIGGER_CONNECTION = "composio"

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

  if (type === "calendar") {
    const leadMatch = objectText.match(/minutesBefore\s*:\s*(\d+)/)
    if (!leadMatch) {
      return { trigger: null, error: "Calendar trigger must use a literal minutesBefore number" }
    }
    return { trigger: { type: "calendar", minutesBefore: Number(leadMatch[1]), missedStrategy } }
  }

  return { trigger: null, error: `Unsupported trigger type: ${type}. Expected: cron, calendar, manual, webhook` }
}

export function prettifyId(id: string): string {
  return id.replace(/[-_]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

export function extractConnections(code: string): string[] {
  const imported = getImportedServers(code)
  if (extractTriggerConfig(code).trigger?.type !== "calendar") return imported
  return imported.includes(CALENDAR_TRIGGER_CONNECTION)
    ? imported
    : [...imported, CALENDAR_TRIGGER_CONNECTION]
}

export function extractTrigger(code: string): string {
  const { trigger } = extractTriggerConfig(code)
  if (!trigger) return ""
  const type = trigger.type
  if (type === "cron") {
    return trigger.cron ? cronToText(trigger.cron) : "Scheduled"
  }
  if (type === "calendar") {
    return trigger.minutesBefore === 0
      ? "At each meeting start"
      : `${trigger.minutesBefore}m before each meeting`
  }
  if (type === "manual") return "Manual"
  if (type === "webhook") return "Webhook"
  return ""
}

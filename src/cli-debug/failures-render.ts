/**
 * Text rendering for `jig debug failures`. Pure, like audit-render. A cron
 * failing every few minutes would fill the screen with one line, so
 * consecutive failures of the same jig with the same cause and step collapse
 * into one entry with a count and the span they cover.
 */
import type { FailureEntry, FailureLog } from "../../shared/api.js"

const ID_COL = 24
const CAUSE_COL = 18
const ERROR_CHARS = 200

interface Group {
  head: FailureEntry
  count: number
  /** Oldest run in the group (entries are newest first). */
  firstAt: string
}

export function renderFailureLog(log: FailureLog, target: { handle: string; url: string; since: string }): string {
  const groups = collapse(log.failures)
  const jigs = new Set(log.failures.map((f) => f.jigId)).size
  const out: string[] = []
  out.push(`${target.handle} (${target.url})  ·  since ${target.since}  ·  ${log.failures.length} failure${log.failures.length === 1 ? "" : "s"} across ${jigs} jig${jigs === 1 ? "" : "s"}${log.truncated ? " (window cut, narrow --since or --jig)" : ""}`)
  if (groups.length === 0) {
    out.push("", "No failed runs in this window.")
    return out.join("\n")
  }
  for (const g of groups) {
    const f = g.head
    const when = g.count > 1 ? `${shortTime(f.at)}  x${g.count} since ${shortTime(g.firstAt)}` : shortTime(f.at)
    out.push("", `${when}  ${f.jigId.padEnd(ID_COL)} ${f.cause.padEnd(CAUSE_COL)} run #${f.runId}${f.step ? ` step ${f.step.seq} "${f.step.label}"` : ""}`)
    out.push(`    ${oneLine(f.error)}`)
    out.push(`    -> ${f.remedy}`)
  }
  return out.join("\n")
}

export function collapse(entries: FailureEntry[]): Group[] {
  const groups: Group[] = []
  for (const f of entries) {
    const last = groups[groups.length - 1]
    if (last && last.head.jigId === f.jigId && last.head.cause === f.cause && last.head.step?.label === f.step?.label) {
      last.count++
      last.firstAt = f.at
    } else {
      groups.push({ head: f, count: 1, firstAt: f.at })
    }
  }
  return groups
}

function shortTime(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")}Z`
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > ERROR_CHARS ? `${flat.slice(0, ERROR_CHARS)}...` : flat
}

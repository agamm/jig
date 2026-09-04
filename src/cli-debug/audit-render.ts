/**
 * Text rendering for `jig debug audit`. Pure: the report comes in, lines go
 * out, so the layout is unit-tested without a server. Sections are ordered by
 * what to do first, and every failing jig ends with the exact next command.
 */
import type { AuditJig, AuditReport } from "../../shared/api.js"

const ID_COL = 24
const TRIGGER_COL = 18
const ERROR_CHARS = 200
const LAST_RUNS = 5

export function renderAuditReport(
  report: AuditReport,
  target: { handle: string; url: string; since: string },
): string {
  const byId = new Map(report.jigs.map((j) => [j.id, j]))
  const failing = report.jigs.filter((j) => j.consecutiveFailures > 0)

  // Each jig lands in one section, the most actionable one that applies.
  const seen = new Set(failing.map((j) => j.id))
  const claim = (ids: string[]): string[] => {
    const mine = ids.filter((id) => !seen.has(id))
    for (const id of mine) seen.add(id)
    return mine
  }
  const scheduleErrors = claim(report.scheduler.problems.map((p) => p.jigId))
  const overdue = claim(report.scheduler.overdue.map((o) => o.jigId))
  const paused = claim(report.scheduler.disabled)
  const healthy = report.jigs.filter((j) => !seen.has(j.id))
  const attention = report.jigs.length - healthy.length

  const out: string[] = []
  out.push(`${target.handle} (${target.url})  ·  since ${target.since}  ·  ${attention} of ${report.jigs.length} jigs need attention`)

  if (failing.length) {
    out.push("", "FAILING")
    for (const jig of failing) out.push(...renderFailing(jig, report))
  }

  if (overdue.length) {
    out.push("", "DEGRADED   (overdue)")
    for (const id of overdue) {
      const due = report.scheduler.overdue.find((o) => o.jigId === id)!
      out.push(`  ${id.padEnd(ID_COL)} ${triggerLabel(byId.get(id)).padEnd(TRIGGER_COL)} due ${shortTime(due.nextRunAt)}, has not started`)
    }
  }

  if (paused.length) {
    out.push("", "PAUSED     (disabled)")
    for (const id of paused) {
      out.push(`  ${id.padEnd(ID_COL)} ${(byId.get(id)?.trigger ?? "?").padEnd(TRIGGER_COL)} disabled on the dashboard; it will not run until re-enabled`)
    }
  }

  if (scheduleErrors.length) {
    out.push("", "SCHEDULE ERRORS")
    for (const id of scheduleErrors) {
      const problem = report.scheduler.problems.find((p) => p.jigId === id)!
      out.push(`  ${id.padEnd(ID_COL)} ${oneLine(problem.error)}`)
    }
  }

  if (report.connections.length) {
    out.push("", "CONNECTIONS   (non-ok)")
    for (const c of report.connections) {
      out.push(`  ${c.name.padEnd(ID_COL)} ${c.state.padEnd(TRIGGER_COL)} since ${shortTime(c.at)}${c.detail ? `: ${oneLine(c.detail)}` : ""}`)
    }
  }

  out.push("", `HEALTHY (${healthy.length})${healthy.length ? `   ${healthy.map((j) => j.id).join(", ")}` : ""}`)

  const sched = report.instance.scheduler
  out.push("", `scheduler: ${sched.running ? "running" : "stopped"}, last tick ${sched.lastTickAt ? shortTime(sched.lastTickAt) : "never"}`)
  return out.join("\n")
}

function renderFailing(jig: AuditJig, report: AuditReport): string[] {
  const lines: string[] = []
  const n = jig.consecutiveFailures
  const since = jig.failingSince ? ` since ${shortTime(jig.failingSince)}` : ""
  const running = jig.running ? "   [running now]" : ""
  lines.push(`  ${jig.id.padEnd(ID_COL)} ${triggerLabel(jig).padEnd(TRIGGER_COL)} ${n} consecutive failure${n === 1 ? "" : "s"}${since}${running}`)

  const f = jig.lastFailure
  if (f?.step) lines.push(`    step ${f.step.seq} "${f.step.label}": ${oneLine(f.error)}`)
  else if (f) lines.push(`    error: ${oneLine(f.error)}`)

  if (jig.runs.length) {
    const recent = jig.runs.slice(0, LAST_RUNS)
    lines.push(`    last ${recent.length}: ${recent.map((r) => r.status === "fail" ? "fail" : r.status === "success" ? "ok" : "running").join(" ")}`)
  }

  for (const name of jig.unhealthyConnections) {
    const c = report.connections.find((x) => x.name === name)
    const state = c ? `${c.state} since ${shortTime(c.at)}` : "unhealthy"
    lines.push(`    connection ${name} is ${state}   <- fix the connection, not the code`)
  }

  if (jig.pending) {
    const p = jig.pending
    lines.push(`    pending v${p.versionId} by ${p.author}${p.likelyRepair ? " (auto-repair)" : ""}: "${p.message ?? ""}"`)
    lines.push(`    -> bun run jig pending ${jig.id}`)
  } else {
    lines.push(`    -> bun run jig edit ${jig.id} --out=${jig.id}.ts   (fix, then --file=, then run --dry-run)`)
  }
  return lines
}

function triggerLabel(jig: AuditJig | undefined): string {
  if (!jig) return "?"
  return jig.enabled ? jig.trigger : `${jig.trigger} (paused)`
}

function shortTime(iso: string): string {
  return `${iso.slice(0, 16).replace("T", " ")}Z`
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > ERROR_CHARS ? `${flat.slice(0, ERROR_CHARS)}...` : flat
}

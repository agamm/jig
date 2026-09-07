/**
 * ASCII rendering of a JigFlow: one box per step, wired top to bottom, each
 * marked AI or code. Level 1 is the shape, level 2 adds the logic and prompt
 * summaries, level 3 the full prompts and every statement.
 */
import type { FlowModelCall, FlowStep, JigFlow } from "../domain/jig-flow.js"

export type DetailLevel = 1 | 2 | 3

export interface RenderOptions {
  level?: DetailLevel
  width?: number
  /** Model used when neither the jig, the step nor the call names one. */
  defaultModel?: string
}

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

function fmtMs(ms: number): string {
  if (ms % 60_000 === 0) return `${ms / 60_000}m`
  if (ms % 1000 === 0) return `${ms / 1000}s`
  return `${ms}ms`
}

/** Word-wraps to `width`, keeping a line's leading indentation on every piece. */
export function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const paragraph of text.split("\n")) {
    if (paragraph.trim() === "") { out.push(""); continue }
    const indent = paragraph.match(/^\s*/)?.[0] ?? ""
    const room = Math.max(8, width - indent.length)
    let line = ""
    for (const word of paragraph.trim().split(/\s+/)) {
      if (word.length > room) {
        if (line) { out.push(indent + line); line = "" }
        for (let i = 0; i < word.length; i += room) out.push(indent + word.slice(i, i + room))
        continue
      }
      if ((line + " " + word).trim().length > room) { out.push(indent + line); line = word }
      else line = line ? `${line} ${word}` : word
    }
    if (line) out.push(indent + line)
  }
  return out
}

function box(header: string, lines: string[], width: number): string[] {
  const inner = width - 4
  const top = `┌─ ${header} ` + "─".repeat(Math.max(0, width - header.length - 5)) + "┐"
  // Content arrives pre-wrapped; this only catches a line that is still too long.
  const body = lines.flatMap((l) => (l.length <= inner ? [l] : wrap(l, inner))).map((l) => `│ ${l.padEnd(inner)} │`)
  const bottom = "└" + "─".repeat(width - 2) + "┘"
  return [top, ...body, bottom]
}

function shortModel(id: string): string {
  return id.split("/").pop() ?? id
}

function callLine(call: FlowModelCall, step: FlowStep, flow: JigFlow, defaultModel?: string): string {
  const model = call.model ?? step.model ?? flow.model ?? defaultModel
  const bits = [`${call.fn}(${model ? shortModel(model) : "default model"})`]
  if (call.structured) bits.push("structured output")
  if (call.fn === "agent") bits.push(call.tools.length ? `${call.tools.length} tool${call.tools.length === 1 ? "" : "s"}` : "no tools")
  if (call.promptFrom !== "literal") bits.push(`prompt from ${call.promptFrom}`)
  return bits.join(" · ")
}

function promptSummary(prompt: string, max = 110): string {
  const s = squash(prompt)
  return s.length > max ? `"${s.slice(0, max - 1)}…"` : `"${s}"`
}

function tags(step: FlowStep): string {
  const t = step.connections.map((c) => `[${c}]`)
  if (step.emails) t.push("[email]")
  return t.join(" ")
}

export function renderFlow(flow: JigFlow, opts: RenderOptions = {}): string {
  const level = opts.level ?? 1
  const width = Math.max(48, Math.min(opts.width ?? 78, 120))
  const inner = width - 4
  const out: string[] = []
  // Wrap here, not in box(), so a continuation line keeps the same prefix as its first line.
  const pushWrapped = (into: string[], prefix: string, text: string, contPrefix = prefix) => {
    const pieces = wrap(text, Math.max(16, inner - Math.max(prefix.length, contPrefix.length)))
    pieces.forEach((piece, i) => into.push((i === 0 ? prefix : contPrefix) + piece))
  }
  const stepModel = (step: FlowStep) => {
    const m = step.calls.find((c) => c.model)?.model ?? step.model ?? flow.model ?? opts.defaultModel
    return m ? shortModel(m) : undefined
  }

  // ---- header ---------------------------------------------------------------
  const ai = flow.steps.filter((s) => s.kind === "ai").length
  const code = flow.steps.length - ai
  out.push(flow.name || "(unnamed jig)")
  const row = (k: string, v: string) => wrap(v, width - 15).forEach((piece, i) => out.push(`  ${(i === 0 ? k : "").padEnd(12)} ${piece}`))
  row("trigger", flow.trigger ? `${flow.triggerRaw} · ${flow.trigger}` : flow.triggerRaw)
  row("model", flow.model ? `${flow.model} (set in source)` : opts.defaultModel ? `${opts.defaultModel} (instance default)` : "instance default")
  row("connections", flow.connections.length ? flow.connections.join(", ") : "none")
  row("steps", `${flow.steps.length} · ${ai} AI · ${code} code`)
  if (flow.params.length) row("params", flow.params.join(", "))
  if (flow.runTimeoutMs || flow.toolTimeoutMs) row("timeouts", [flow.runTimeoutMs && `run ${fmtMs(flow.runTimeoutMs)}`, flow.toolTimeoutMs && `tool ${fmtMs(flow.toolTimeoutMs)}`].filter(Boolean).join(" · "))
  out.push("")

  // ---- steps ----------------------------------------------------------------
  const connector = " ".repeat(Math.floor(width / 2)) + "│"
  flow.steps.forEach((step, i) => {
    const lines: string[] = [step.label]
    const tagLine = tags(step)
    if (tagLine) lines.push(tagLine)

    if (level >= 2) {
      const detail: string[] = []
      for (const call of step.calls) {
        detail.push(callLine(call, step, flow, opts.defaultModel))
        if (call.tools.length) detail.push(`  tools: ${call.tools.map((t) => t.split(".").slice(1).join(".")).join(", ")}`)
        if (call.prompt) {
          if (level === 2) pushWrapped(detail, "  ", promptSummary(call.prompt))
          else { detail.push("  prompt:"); for (const l of call.prompt.split("\n")) pushWrapped(detail, "  │ ", l || " ") }
        }
      }
      const directTools = step.tools.filter((t) => !step.calls.some((c) => c.tools.includes(t)))
      if (directTools.length) detail.push(`tools: ${directTools.join(", ")}`)
      if (step.emails) detail.push(`emails you${step.emails > 1 ? ` (${step.emails}x)` : ""}`)
      if (step.model && !step.calls.length) detail.push(`model: ${step.model}`)
      const logicRows = level === 3 ? step.statements : step.logic
      if (logicRows.length) {
        detail.push(level === 3 ? "logic (every statement):" : "logic:")
        for (const s of logicRows) {
          const indent = "  " + "  ".repeat(s.depth)
          const tag = s.kind === "other" ? "· " : `[${s.kind}] `
          pushWrapped(detail, indent + tag, s.text, indent + " ".repeat(tag.length))
        }
      }
      if (detail.length) lines.push("", ...detail)
    }

    const model = step.kind === "ai" ? stepModel(step) : undefined
    out.push(...box(`${step.seq} · ${step.kind === "ai" ? `AI${model ? ` · ${model}` : ""}` : "code"}`, lines, width))
    if (i < flow.steps.length - 1) out.push(connector)
  })
  if (flow.steps.length === 0) out.push("(no ctx.step() calls found)")

  // ---- footer ---------------------------------------------------------------
  out.push("")
  for (const w of flow.warnings) out.push(...wrap(`! ${w}`, width))
  out.push(...wrap("AI = an llm() or agent() call decides the content · code = deterministic TypeScript", width))
  if (level < 3) out.push(...wrap(level === 1 ? "-v adds logic and prompt summaries, -vv the full prompts and every statement" : "-vv shows the full prompts and every statement", width))
  return out.join("\n").replace(/[ \t]+$/gm, "") + "\n"
}

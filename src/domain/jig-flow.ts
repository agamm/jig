/**
 * Static flow analysis of a jig: the steps in source order, what each one
 * touches (connections, tools, mail), whether a model decides its content, the
 * prompts it sends, and the control flow around them. TypeScript AST, no
 * execution. Feeds `jig visualize` and is reusable by anything that wants to
 * explain a jig without running it.
 */
import ts from "typescript"
import { getConnectionImportBindings } from "./source-analysis.js"
import { extractTrigger, extractTriggerConfig } from "./jig-source.js"

export type FlowStatementKind =
  | "if" | "else" | "loop" | "parallel" | "skip" | "throw" | "try" | "catch" | "return"
  | "email" | "output" | "tool" | "llm" | "agent" | "step" | "other"

export interface FlowStatement {
  kind: FlowStatementKind
  text: string
  depth: number
}

export interface FlowModelCall {
  fn: "llm" | "agent"
  /** Per-call model override, when the call passes one. */
  model?: string
  /** True when the call asks for a schema (structured output). */
  structured: boolean
  /** agent() only: the tools handed to it, as "server.tool". */
  tools: string[]
  /** The prompt with interpolations kept as ${expr}. */
  prompt: string
  promptFrom: "literal" | "variable" | "expression"
  line: number
}

export interface FlowStep {
  seq: number
  label: string
  /** ai: an llm()/agent() call decides the content. code: deterministic TypeScript. */
  kind: "ai" | "code"
  connections: string[]
  /** Tools declared for the step or called in its body, as "server.tool". */
  tools: string[]
  /** Step-level model option, when set. */
  model?: string
  calls: FlowModelCall[]
  emails: number
  outputs: number
  /** Control flow worth knowing about: conditions, loops, parallel, skip, throw, try. */
  logic: FlowStatement[]
  /** Every statement in the step body, flattened with depth, for the full breakdown. */
  statements: FlowStatement[]
  line: number
}

export interface JigFlow {
  name: string
  /** Human text, e.g. "Fridays at 16:00". */
  trigger: string
  /** The raw trigger, e.g. "cron 0 16 * * 5" or "email". */
  triggerRaw: string
  model?: string
  runTimeoutMs?: number
  toolTimeoutMs?: number
  connections: string[]
  params: string[]
  steps: FlowStep[]
  warnings: string[]
}

const NOTABLE: ReadonlySet<FlowStatementKind> = new Set(["if", "else", "loop", "parallel", "skip", "throw", "try", "catch"])
const MAX_STATEMENTS = 80
const MAX_DEPTH = 3

function squash(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function analyzeJigFlow(code: string, fileName = "jig.ts"): JigFlow {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bindings = new Map(getConnectionImportBindings(code, fileName).map((b) => [b.localName, b.serverName]))
  const text = (n: ts.Node) => n.getText(sf)
  const lineOf = (n: ts.Node) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1

  // ---- helpers over the tree ------------------------------------------------

  const isCtxCall = (n: ts.Node, method: string): n is ts.CallExpression =>
    ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === method &&
    ts.isIdentifier(n.expression.expression) && n.expression.expression.text === "ctx"

  const modelCallName = (n: ts.Node): "llm" | "agent" | null => {
    if (!ts.isCallExpression(n) || !ts.isIdentifier(n.expression)) return null
    return n.expression.text === "llm" ? "llm" : n.expression.text === "agent" ? "agent" : null
  }

  const toolRef = (n: ts.Node): string | null => {
    if (!ts.isPropertyAccessExpression(n) || !ts.isIdentifier(n.expression)) return null
    const server = bindings.get(n.expression.text)
    return server ? `${server}.${n.name.text}` : null
  }

  const literalText = (n: ts.Node | undefined): string | null => {
    if (!n) return null
    if (ts.isParenthesizedExpression(n)) return literalText(n.expression)
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text
    if (ts.isTemplateExpression(n)) {
      return n.head.text + n.templateSpans.map((s) => "${" + squash(text(s.expression)) + "}" + s.literal.text).join("")
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = literalText(n.left), right = literalText(n.right)
      return left !== null && right !== null ? left + right : null
    }
    return null
  }

  const propValue = (obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined => {
    for (const p of obj.properties) {
      if (ts.isPropertyAssignment(p) && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) && p.name.text === name) return p.initializer
      if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name
    }
    return undefined
  }
  const propString = (obj: ts.ObjectLiteralExpression, name: string) => {
    const v = propValue(obj, name)
    return v ? literalText(v) ?? undefined : undefined
  }
  const propNumber = (obj: ts.ObjectLiteralExpression, name: string) => {
    const v = propValue(obj, name)
    if (!v) return undefined
    const n = Number(text(v).replace(/_/g, ""))
    return Number.isFinite(n) ? n : undefined
  }

  // Tool arrays and string constants declared anywhere in the file, by name.
  const toolVars = new Map<string, string[]>()
  const stringVars = new Map<string, string>()
  const collectDecls = (n: ts.Node) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      if (ts.isArrayLiteralExpression(n.initializer)) {
        const refs = n.initializer.elements.map(toolRef).filter((r): r is string => r !== null)
        if (refs.length > 0) toolVars.set(n.name.text, refs)
      } else {
        const s = literalText(n.initializer)
        if (s !== null) stringVars.set(n.name.text, s)
      }
    }
    ts.forEachChild(n, collectDecls)
  }
  collectDecls(sf)

  const resolveTools = (arg: ts.Node | undefined): string[] => {
    if (!arg) return []
    if (ts.isIdentifier(arg)) return toolVars.get(arg.text) ?? []
    if (!ts.isArrayLiteralExpression(arg)) return []
    const out: string[] = []
    for (const el of arg.elements) {
      const ref = toolRef(el)
      if (ref) out.push(ref)
      else if (ts.isSpreadElement(el) && ts.isIdentifier(el.expression)) out.push(...(toolVars.get(el.expression.text) ?? []))
      else if (ts.isIdentifier(el)) out.push(...(toolVars.get(el.text) ?? []))
    }
    return out
  }

  // Statement text with long string and template literals abbreviated: the
  // prompts are reported separately in full, and here they would drown the logic.
  const condense = (n: ts.Node, max = 120): string => {
    const start = n.getStart(sf)
    const raw = text(n)
    const cuts: { s: number; e: number; r: string }[] = []
    const find = (x: ts.Node) => {
      if ((ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x) || ts.isTemplateExpression(x)) && x.getEnd() - x.getStart(sf) > 40) {
        const first = squash(literalText(x) ?? "").slice(0, 24)
        cuts.push({ s: x.getStart(sf) - start, e: x.getEnd() - start, r: `"${first}…"` })
        return
      }
      ts.forEachChild(x, find)
    }
    find(n)
    let out = raw
    for (const c of cuts.sort((a, b) => b.s - a.s)) out = out.slice(0, c.s) + c.r + out.slice(c.e)
    out = squash(out)
    return out.length > max ? out.slice(0, max - 1) + "…" : out
  }

  const headOf = (stmt: ts.Node): string => {
    const t = text(stmt)
    const brace = t.indexOf("{")
    return squash(brace > 0 ? t.slice(0, brace) : t).slice(0, 120)
  }

  const classifyExpression = (stmt: ts.Node): FlowStatementKind => {
    let kind: FlowStatementKind = "other"
    const look = (x: ts.Node) => {
      if (kind !== "other") return
      if (isCtxCall(x, "parallel")) kind = "parallel"
      else if (isCtxCall(x, "skip")) kind = "skip"
      else if (isCtxCall(x, "email")) kind = "email"
      else if (isCtxCall(x, "output")) kind = "output"
      else if (isCtxCall(x, "step")) kind = "step"
      else if (modelCallName(x)) kind = modelCallName(x)!
      else if (ts.isCallExpression(x) && toolRef(x.expression)) kind = "tool"
      if (kind === "other") ts.forEachChild(x, look)
    }
    look(stmt)
    return kind
  }

  const flatten = (stmts: readonly ts.Statement[], depth: number, out: FlowStatement[]) => {
    for (const stmt of stmts) {
      if (out.length >= MAX_STATEMENTS) return
      if (ts.isIfStatement(stmt)) {
        out.push({ kind: "if", text: `if (${squash(text(stmt.expression)).slice(0, 110)})`, depth })
        flatten(blockStatements(stmt.thenStatement), depth + 1, out)
        if (stmt.elseStatement) {
          if (ts.isIfStatement(stmt.elseStatement)) flatten([stmt.elseStatement], depth, out)
          else { out.push({ kind: "else", text: "else", depth }); flatten(blockStatements(stmt.elseStatement), depth + 1, out) }
        }
      } else if (ts.isForOfStatement(stmt) || ts.isForInStatement(stmt) || ts.isForStatement(stmt) || ts.isWhileStatement(stmt) || ts.isDoStatement(stmt)) {
        out.push({ kind: "loop", text: headOf(stmt), depth })
        flatten(blockStatements(stmt.statement), depth + 1, out)
      } else if (ts.isTryStatement(stmt)) {
        out.push({ kind: "try", text: "try", depth })
        flatten(stmt.tryBlock.statements, depth + 1, out)
        if (stmt.catchClause) {
          out.push({ kind: "catch", text: `catch${stmt.catchClause.variableDeclaration ? ` (${text(stmt.catchClause.variableDeclaration)})` : ""}`, depth })
          flatten(stmt.catchClause.block.statements, depth + 1, out)
        }
      } else if (ts.isThrowStatement(stmt)) {
        out.push({ kind: "throw", text: condense(stmt), depth })
      } else if (ts.isReturnStatement(stmt)) {
        out.push({ kind: stmt.expression && classifyExpression(stmt.expression) !== "other" ? classifyExpression(stmt.expression) : "return", text: condense(stmt), depth })
      } else if (ts.isBlock(stmt)) {
        flatten(stmt.statements, depth, out)
      } else {
        out.push({ kind: classifyExpression(stmt), text: condense(stmt), depth })
      }
    }
  }
  const blockStatements = (n: ts.Statement): readonly ts.Statement[] => (ts.isBlock(n) ? n.statements : [n])

  const analyzeModelCall = (call: ts.CallExpression, fn: "llm" | "agent"): FlowModelCall => {
    const [promptArg, secondArg, thirdArg] = call.arguments
    let prompt = "", promptFrom: FlowModelCall["promptFrom"] = "expression"
    const lit = literalText(promptArg)
    if (lit !== null) { prompt = lit; promptFrom = "literal" }
    else if (promptArg && ts.isIdentifier(promptArg) && stringVars.has(promptArg.text)) { prompt = stringVars.get(promptArg.text)!; promptFrom = "variable" }
    else if (promptArg) { prompt = squash(text(promptArg)); promptFrom = "expression" }
    // llm(prompt, data, options) by contract, but a call with no data passes options second.
    const isOptions = (n: ts.Node | undefined): n is ts.ObjectLiteralExpression =>
      !!n && ts.isObjectLiteralExpression(n) && ["schema", "model", "maxTokens"].some((k) => propValue(n, k) !== undefined)
    const options = isOptions(thirdArg) ? thirdArg : fn === "llm" && isOptions(secondArg) ? secondArg : undefined
    return {
      fn,
      model: options ? propString(options, "model") : undefined,
      structured: options ? propValue(options, "schema") !== undefined : false,
      tools: fn === "agent" ? resolveTools(secondArg) : [],
      prompt,
      promptFrom,
      line: lineOf(call),
    }
  }

  const analyzeStep = (call: ts.CallExpression, seq: number): FlowStep => {
    const [labelArg, toolsArg, cbArg, optsArg] = call.arguments
    const label = literalText(labelArg) ?? (labelArg ? `<${squash(text(labelArg)).slice(0, 40)}>` : "<unnamed>")
    const declared = resolveTools(toolsArg)
    const model = optsArg && ts.isObjectLiteralExpression(optsArg) ? propString(optsArg, "model") : undefined
    const calls: FlowModelCall[] = []
    const used = new Set<string>(declared)
    let emails = 0, outputs = 0
    const scan = (n: ts.Node) => {
      const fn = modelCallName(n)
      if (fn) { const mc = analyzeModelCall(n as ts.CallExpression, fn); calls.push(mc); mc.tools.forEach((t) => used.add(t)) }
      else if (isCtxCall(n, "email")) emails++
      else if (isCtxCall(n, "output")) outputs++
      else if (ts.isCallExpression(n)) { const ref = toolRef(n.expression); if (ref) used.add(ref) }
      ts.forEachChild(n, scan)
    }
    if (cbArg) scan(cbArg)
    const statements: FlowStatement[] = []
    if (cbArg && (ts.isArrowFunction(cbArg) || ts.isFunctionExpression(cbArg))) {
      if (ts.isBlock(cbArg.body)) flatten(cbArg.body.statements, 0, statements)
      else statements.push({ kind: classifyExpression(cbArg.body), text: condense(cbArg.body), depth: 0 })
    }
    const tools = [...used]
    return {
      seq,
      label,
      kind: calls.length > 0 ? "ai" : "code",
      connections: [...new Set(tools.map((t) => t.split(".")[0]))],
      tools,
      model,
      calls,
      emails,
      outputs,
      logic: statements.filter((s) => NOTABLE.has(s.kind) && s.depth < MAX_DEPTH),
      statements,
      line: lineOf(call),
    }
  }

  // ---- walk -----------------------------------------------------------------

  let name = "", model: string | undefined, runTimeoutMs: number | undefined, toolTimeoutMs: number | undefined
  const steps: FlowStep[] = []
  const warnings: string[] = []
  const params = new Set<string>()
  let stepDepth = 0

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "jig" && !name) {
      name = literalText(node.arguments[0]) ?? ""
      const opts = node.arguments[1]
      if (opts && ts.isObjectLiteralExpression(opts)) {
        model = propString(opts, "model")
        runTimeoutMs = propNumber(opts, "runTimeoutMs")
        toolTimeoutMs = propNumber(opts, "toolTimeoutMs")
      }
    }
    if (ts.isPropertyAccessExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "params" &&
        ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "ctx") {
      params.add(node.name.text)
    }
    if (isCtxCall(node, "step")) {
      if (stepDepth > 0) warnings.push(`Nested ctx.step() at line ${lineOf(node)}: steps must not contain steps.`)
      else steps.push(analyzeStep(node, steps.length + 1))
      stepDepth++
      ts.forEachChild(node, visit)
      stepDepth--
      return
    }
    const fn = modelCallName(node)
    if (fn && stepDepth === 0) warnings.push(`${fn}() outside any ctx.step() at line ${lineOf(node)}: it will not be recorded as a step.`)
    ts.forEachChild(node, visit)
  }
  visit(sf)

  const { trigger } = extractTriggerConfig(code)
  const triggerRaw = !trigger ? "none" : trigger.type === "cron" ? `cron ${trigger.cron}` : trigger.type === "calendar" ? `calendar ${trigger.minutesBefore}m before` : trigger.type
  return {
    name,
    trigger: extractTrigger(code),
    triggerRaw,
    model,
    runTimeoutMs,
    toolTimeoutMs,
    connections: [...new Set([...bindings.values()])],
    params: [...params],
    steps,
    warnings,
  }
}

/**
 * Jig file validator — checks that jig files export a valid JigDefinition.
 *
 * Used by jig-gen after generating/editing jigs,
 * and can be run standalone: bun run src/validate.ts jigs/weekly-update.ts
 */
import { existsSync } from "fs"
import ts from "typescript"
import type { JigDefinition, JigTrigger } from "./sdk/jig.js"
import { PROJECT_ROOT } from "./config/paths.js"
import { toolNameToIdentifier } from "./mcp/typegen.js"
import { getConnectionImportBindings, getConnectionToolReferences } from "./domain/source-analysis.js"
import { getJigTsCompilerOptions } from "./domain/jig-ts-options.js"
import { materializeJigWithRuntimeImports } from "./domain/runtime-imports.js"
import { getAgentMailSettings } from "./services/agentmail.js"

// ---------------------------------------------------------------------------
// Validation errors
// ---------------------------------------------------------------------------

export interface ValidationError {
  field: string
  message: string
}

export interface ValidationResult {
  ok: boolean
  errors: ValidationError[]
  definition?: JigDefinition
}

// ---------------------------------------------------------------------------
// Trigger validation
// ---------------------------------------------------------------------------

const CRON_REGEX = /^(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)\s+(\*|[0-9,\-\/]+)$/

function validateTrigger(trigger: unknown): ValidationError[] {
  const errors: ValidationError[] = []
  if (trigger === undefined) {
    return [{ field: "trigger", message: 'Trigger is required. Use { type: "manual" } for manually-triggered jigs.' }]
  }

  if (typeof trigger !== "object" || trigger === null || !("type" in trigger)) {
    errors.push({ field: "trigger", message: "Trigger must be an object with a 'type' field" })
    return errors
  }

  const t = trigger as Record<string, unknown>
  switch (t.type) {
    case "cron":
      if (typeof t.cron !== "string") {
        errors.push({ field: "trigger.cron", message: "Cron trigger requires a 'cron' string" })
      } else if (!CRON_REGEX.test(t.cron.trim())) {
        errors.push({ field: "trigger.cron", message: `Invalid cron expression: "${t.cron}". Expected 5 fields: minute hour day month weekday` })
      }
      break
    case "manual":
    case "webhook":
      break // no additional fields required
    default:
      errors.push({ field: "trigger.type", message: `Unknown trigger type: "${t.type}". Expected: cron, manual, webhook` })
  }
  return errors
}

// ---------------------------------------------------------------------------
// Definition validation
// ---------------------------------------------------------------------------

function validateDefinition(def: unknown): ValidationError[] {
  const errors: ValidationError[] = []

  if (typeof def !== "object" || def === null) {
    errors.push({ field: "default", message: "Default export must be an object (JigDefinition)" })
    return errors
  }

  const d = def as Record<string, unknown>

  // name
  if (typeof d.name !== "string" || !d.name) {
    errors.push({ field: "name", message: "Jig must have a non-empty 'name' string" })
  }

  // options
  if (typeof d.options !== "object" || d.options === null) {
    errors.push({ field: "options", message: "Jig must have an 'options' object" })
  } else {
    const opts = d.options as Record<string, unknown>

    // trigger
    errors.push(...validateTrigger(opts.trigger))

    // tools
    if (opts.tools !== undefined) {
      if (!Array.isArray(opts.tools)) {
        errors.push({ field: "options.tools", message: "Tools must be an array" })
      }
    }

    if (opts.params !== undefined) {
      errors.push({
        field: "options.params",
        message: "Jig options.params is no longer supported. Use runtime ctx.params from webhook/manual payloads without declaring params in the jig options.",
      })
    }
  }

  // handler
  if (typeof d.handler !== "function") {
    errors.push({ field: "handler", message: "Jig must have a 'handler' function" })
  }

  return errors
}

// ---------------------------------------------------------------------------
// Tool declaration validation
// ---------------------------------------------------------------------------

/**
 * Check that all tool calls in source are declared in the tools array.
 */
export function checkToolDeclarations(code: string, declaredToolNames: string[]): ValidationError[] {
  const errors: ValidationError[] = []
  const declared = new Set(declaredToolNames)
  const declaredIdentifiers = new Set(declaredToolNames.map(toolNameToIdentifier))

  for (const ref of getConnectionToolReferences(code)) {
    if (!declared.has(ref.toolName) && !declaredIdentifiers.has(ref.toolName)) {
      errors.push({
        field: `tools.${ref.serverName}.${ref.toolName}`,
        message: `Tool "${ref.serverName}.${ref.toolName}" is used but not declared in the jig's tools array.`,
      })
    }
  }

  // Dedupe
  const seen = new Set<string>()
  return errors.filter(e => {
    if (seen.has(e.field)) return false
    seen.add(e.field)
    return true
  })
}

function isCtxStepCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false
  const expr = node.expression
  return ts.isPropertyAccessExpression(expr)
    && ts.isIdentifier(expr.expression)
    && expr.expression.text === "ctx"
    && expr.name.text === "step"
}

function getConnectionToolReferenceFromExpression(
  expr: ts.Expression,
  bindings: Map<string, string>
): { serverName: string; toolName: string } | null {
  if (!ts.isPropertyAccessExpression(expr) || !ts.isIdentifier(expr.expression)) return null
  const serverName = bindings.get(expr.expression.text)
  if (!serverName) return null
  return { serverName, toolName: expr.name.text }
}

function collectToolArrayInitializers(sf: ts.SourceFile): Map<string, ts.Expression> {
  const vars = new Map<string, ts.Expression>()

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      vars.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  return vars
}

function resolveStepToolArray(
  expr: ts.Expression | undefined,
  bindings: Map<string, string>,
  vars: Map<string, ts.Expression>,
  seen = new Set<string>()
): Set<string> {
  const resolved = new Set<string>()
  if (!expr) return resolved

  const addExpr = (child: ts.Expression | undefined) => {
    for (const value of resolveStepToolArray(child, bindings, vars, seen)) {
      resolved.add(value)
    }
  }

  if (ts.isArrayLiteralExpression(expr)) {
    for (const element of expr.elements) {
      if (ts.isSpreadElement(element)) {
        addExpr(element.expression)
        continue
      }
      if (ts.isExpression(element)) {
        addExpr(element)
      }
    }
    return resolved
  }

  if (ts.isIdentifier(expr)) {
    if (seen.has(expr.text)) return resolved
    seen.add(expr.text)
    addExpr(vars.get(expr.text))
    seen.delete(expr.text)
    return resolved
  }

  const ref = getConnectionToolReferenceFromExpression(expr, bindings)
  if (ref) {
    resolved.add(`${ref.serverName}.${ref.toolName}`)
  }

  return resolved
}

export function checkStepToolDeclarations(code: string, fileName = "jig.ts"): ValidationError[] {
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bindings = new Map(
    getConnectionImportBindings(code, fileName).map((binding) => [binding.localName, binding.serverName])
  )
  const toolVars = collectToolArrayInitializers(sf)
  const errors: ValidationError[] = []

  const visitStep = (node: ts.Node) => {
    if (!isCtxStepCall(node)) {
      ts.forEachChild(node, visitStep)
      return
    }

    const stepLabel = node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
      ? node.arguments[0].text
      : "(dynamic step)"
    const allowedTools = resolveStepToolArray(node.arguments[1], bindings, toolVars)
    const callback = node.arguments[2]
    if (!callback || (!ts.isArrowFunction(callback) && !ts.isFunctionExpression(callback))) {
      return
    }

    const scan = (child: ts.Node) => {
      if (isCtxStepCall(child)) return
      if (ts.isPropertyAccessExpression(child)) {
        const ref = getConnectionToolReferenceFromExpression(child, bindings)
        if (ref) {
          const qualified = `${ref.serverName}.${ref.toolName}`
          if (!allowedTools.has(qualified)) {
            errors.push({
              field: `steps.${stepLabel}.${qualified}`,
              message: `Tool "${qualified}" is used inside step "${stepLabel}" but is not declared in that step's tools array. Add it to that ctx.step() call or move it into a separate step.`,
            })
          }
        }
      }
      ts.forEachChild(child, scan)
    }

    scan(callback.body)
  }

  visitStep(sf)

  const seen = new Set<string>()
  return errors.filter((error) => {
    if (seen.has(error.field)) return false
    seen.add(error.field)
    return true
  })
}

type ConnectionToolCall = {
  serverName: string
  toolName: string
  start: number
  end: number
}

let validationCompilerOptions: ts.CompilerOptions | null = null

function getValidationCompilerOptions(): ts.CompilerOptions {
  if (validationCompilerOptions) return validationCompilerOptions

  validationCompilerOptions = getJigTsCompilerOptions({ noEmit: true })
  return validationCompilerOptions
}

function collectConnectionToolCalls(sf: ts.SourceFile): ConnectionToolCall[] {
  const bindings = new Map(
    getConnectionImportBindings(sf.text, sf.fileName).map((binding) => [binding.localName, binding.serverName])
  )
  const calls: ConnectionToolCall[] = []

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node)) {
      const ref = ts.isPropertyAccessExpression(node.expression) && ts.isIdentifier(node.expression.expression)
        ? {
            serverName: bindings.get(node.expression.expression.text),
            toolName: node.expression.name.text,
          }
        : ts.isElementAccessExpression(node.expression)
            && ts.isIdentifier(node.expression.expression)
            && node.expression.argumentExpression
            && ts.isStringLiteralLike(node.expression.argumentExpression)
          ? {
              serverName: bindings.get(node.expression.expression.text),
              toolName: node.expression.argumentExpression.text,
            }
          : null

      if (ref?.serverName) {
        calls.push({
          serverName: ref.serverName,
          toolName: ref.toolName,
          start: node.getStart(sf),
          end: node.getEnd(),
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)
  return calls
}

function normalizeDiagnosticMessage(messageText: string): string {
  return messageText.replace(/\s+/g, " ").trim()
}

function extractMissingFields(message: string): string[] {
  const single = message.match(/Property '([^']+)' is missing/)
  if (single) return [single[1]]

  const many = message.match(/missing the following properties from type [^:]+: (.+)$/i)
  if (!many) return []

  return many[1]
    .split(",")
    .map((part) => part.trim().replace(/^and\s+/i, ""))
    .map((part) => part.replace(/\.$/, ""))
    .filter(Boolean)
}

function formatTypedToolDiagnostic(call: ConnectionToolCall, diagnostic: ts.DiagnosticWithLocation): ValidationError[] {
  const message = normalizeDiagnosticMessage(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "))
  const missingFields = extractMissingFields(message)
  if (missingFields.length > 0) {
    return missingFields.map((field) => ({
      field: `params.${call.serverName}.${call.toolName}.${field}`,
      message: `Tool "${call.serverName}.${call.toolName}" is called without required parameter "${field}".`,
    }))
  }

  return [{
    field: `params.${call.serverName}.${call.toolName}`,
    message: `TypeScript validation failed for tool "${call.serverName}.${call.toolName}": ${message}`,
  }]
}

function checkTypedToolCallDiagnostics(path: string): ValidationError[] {
  const resolvedPath = ts.sys.resolvePath(path)
  const program = ts.createProgram({
    rootNames: [resolvedPath],
    options: getValidationCompilerOptions(),
  })
  const sf = program.getSourceFile(resolvedPath)
  if (!sf) return []

  const toolCalls = collectConnectionToolCalls(sf)
  if (toolCalls.length === 0) return []

  const diagnostics = [
    ...program.getSyntacticDiagnostics(sf),
    ...program.getSemanticDiagnostics(sf),
  ].filter((diagnostic): diagnostic is ts.DiagnosticWithLocation => (
    diagnostic.file?.fileName === sf.fileName && typeof diagnostic.start === "number"
  ))

  const errors: ValidationError[] = []
  for (const diagnostic of diagnostics) {
    const start = diagnostic.start
    const end = start + (diagnostic.length ?? 0)
    const matchingCall = toolCalls
      .filter((call) => start < call.end && end > call.start)
      .sort((a, b) => (a.end - a.start) - (b.end - b.start))[0]

    if (!matchingCall) continue
    errors.push(...formatTypedToolDiagnostic(matchingCall, diagnostic))
  }

  const seen = new Set<string>()
  return errors.filter((error) => {
    const key = `${error.field}:${error.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * Reject instructional placeholder jigs that narrate setup instead of doing the work.
 */
export function checkPlaceholderJigPatterns(code: string): ValidationError[] {
  const errors: ValidationError[] = []

  const importRe = /import\s*\{[^}]*\b(\w+)\b[^}]*\}\s*from\s*["'](?:@jig|jig|(?:\.\.\/)+\.jig)\/connections\/([A-Za-z0-9_-]+)(?:\.(?:js|ts))?["']/g
  const connectionVars = [...code.matchAll(importRe)].map((match) => match[1])
  const codeWithoutConnectionImports = code.replace(importRe, "")
  const hasConnectionImport = connectionVars.length > 0
  const hasRuntimeConnectionUse = connectionVars.some((varName) => {
    const directCallRe = new RegExp(`\\b${varName}\\.(\\w+)\\s*\\(`, "g")
    const stepToolRe = new RegExp(`\\bctx\\.step\\s*\\([\\s\\S]*?\\[[\\s\\S]*?\\b${varName}\\.(\\w+)\\b`, "m")
    const agentToolRe = new RegExp(`\\bagent\\s*(?:<[^>]+>)?\\s*\\([\\s\\S]*?\\[[\\s\\S]*?\\b${varName}\\.(\\w+)\\b`, "m")
    return directCallRe.test(codeWithoutConnectionImports)
      || stepToolRe.test(codeWithoutConnectionImports)
      || agentToolRe.test(codeWithoutConnectionImports)
  })
  const hasInstructionalConnect = /\bjig connect\s+[a-z0-9_-]+/i.test(code)
  const hasPlaceholderCopy =
    /once connected/i.test(code) ||
    /this jig is designed to/i.test(code) ||
    /configure .*credentials/i.test(code) ||
    /example output/i.test(code)
  const fabricatesExampleOutput =
    /llm\s*\(\s*["'`][^"'`]*generate example output/i.test(code) ||
    /llm\s*\(\s*["'`][^"'`]*example output/i.test(code)

  if (fabricatesExampleOutput) {
    errors.push({
      field: "behavior.placeholder-output",
      message: "Do not use llm() to fabricate example output. Use real tools or fail creation/editing if the required connection is unavailable.",
    })
  }

  if (hasInstructionalConnect) {
    errors.push({
      field: "behavior.setup-instructions",
      message: 'Do not tell the user to run "jig connect ..." from inside a jig. If the workflow needs that connection, fail creation/editing instead of generating placeholder code.',
    })
  }

  if ((hasPlaceholderCopy || hasInstructionalConnect) && !hasRuntimeConnectionUse) {
    errors.push({
      field: "behavior.placeholder-jig",
      message: "Jig only contains setup/instructional placeholder behavior instead of performing real work. Use the required tools or fail creation/editing.",
    })
  }

  if (hasConnectionImport && !hasRuntimeConnectionUse) {
    errors.push({
      field: "behavior.unused-connections",
      message: "Jig imports connections but never uses any connection tools. Do not import a service unless the jig actually uses it.",
    })
  }

  const seen = new Set<string>()
  return errors.filter((error) => {
    if (seen.has(error.field)) return false
    seen.add(error.field)
    return true
  })
}

const SELF_GMAIL_RECIPIENT_KEYS = new Set(["recipient_email", "to", "recipient"])
const SELF_GMAIL_RECIPIENT_VALUES = new Set(["me", "self"])
const GMAIL_SEND_TOOL_RE = /^gmail_send(?:_email)?$/i

function objectLiteralPropValue(obj: ts.ObjectLiteralExpression, key: string): string | null {
  for (const prop of obj.properties) {
    if (!ts.isPropertyAssignment(prop)) continue
    const name = ts.isIdentifier(prop.name)
      ? prop.name.text
      : ts.isStringLiteralLike(prop.name)
        ? prop.name.text
        : null
    if (name !== key) continue
    if (ts.isStringLiteralLike(prop.initializer)) return prop.initializer.text.trim()
  }
  return null
}

function isSelfDirectedGmailRecipient(value: string, ownerEmail: string | null): boolean {
  const normalized = value.trim().toLowerCase()
  if (!normalized) return false
  if (SELF_GMAIL_RECIPIENT_VALUES.has(normalized)) return true
  if (ownerEmail && normalized === ownerEmail.trim().toLowerCase()) return true
  return false
}

/**
 * Prefer ctx.email() for mail to the jig owner. MCP gmail_send* with recipient
 * "me"/"self"/AgentMail owner is a common auth-failure mode — catch at check_jig.
 */
export function checkPreferCtxEmailForSelfGmail(
  code: string,
  fileName = "jig.ts",
  opts?: { ownerEmail?: string | null },
): ValidationError[] {
  const errors: ValidationError[] = []
  const sf = ts.createSourceFile(fileName, code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const bindings = new Map(
    getConnectionImportBindings(code, fileName).map((binding) => [binding.localName, binding.serverName])
  )
  const ownerEmail = opts?.ownerEmail ?? null

  const visit = (node: ts.Node) => {
    if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const expr = node.expression
      let serverName: string | undefined
      let toolName: string | undefined
      if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
        serverName = bindings.get(expr.expression.text)
        toolName = expr.name.text
      } else if (
        ts.isElementAccessExpression(expr) &&
        ts.isIdentifier(expr.expression) &&
        expr.argumentExpression &&
        ts.isStringLiteralLike(expr.argumentExpression)
      ) {
        serverName = bindings.get(expr.expression.text)
        toolName = expr.argumentExpression.text
      }

      if (serverName && toolName && GMAIL_SEND_TOOL_RE.test(toolName)) {
        const arg0 = node.arguments[0]
        if (ts.isObjectLiteralExpression(arg0)) {
          for (const key of SELF_GMAIL_RECIPIENT_KEYS) {
            const value = objectLiteralPropValue(arg0, key)
            if (value != null && isSelfDirectedGmailRecipient(value, ownerEmail)) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
              errors.push({
                field: `email.${serverName}.${toolName}`,
                message:
                  `Line ${line + 1}: use ctx.email({ subject, text|html }) to email the user instead of ` +
                  `${serverName}.${toolName}({ ${key}: "${value}" }). MCP Gmail send is for third parties; ` +
                  `user-directed mail should use AgentMail via ctx.email (no Gmail connection needed).`,
              })
              break
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(sf)

  const seen = new Set<string>()
  return errors.filter((error) => {
    const key = `${error.field}:${error.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

// ---------------------------------------------------------------------------
// File validation (import + check)
// ---------------------------------------------------------------------------

/**
 * Validate a jig file by importing it and checking its default export.
 * Returns validation result with errors (if any) and the definition.
 */
export async function validateJigFile(path: string): Promise<ValidationResult> {
  if (!existsSync(path)) {
    return { ok: false, errors: [{ field: "file", message: `File not found: ${path}` }] }
  }

  try {
    const source = require("fs").readFileSync(path, "utf-8")
    const importPath = await materializeJigWithRuntimeImports(path, source)
    const mod = await import(`${importPath}?_t=${Date.now()}_${Math.random().toString(36).slice(2)}`)
    if (!mod.default) {
      return { ok: false, errors: [{ field: "default", message: "Jig file must have a default export" }] }
    }

    const errors = validateDefinition(mod.default)

    try {
      const code = source
      const tools = mod.default?.options?.tools
      if (Array.isArray(tools) && tools.length > 0) {
        const declaredNames = tools.map((t: any) => t._toolName).filter(Boolean)
        errors.push(...checkToolDeclarations(code, declaredNames))
      }
      errors.push(...checkStepToolDeclarations(code, path))
      errors.push(...checkTypedToolCallDiagnostics(path))
      errors.push(...checkPlaceholderJigPatterns(code))
      let ownerEmail: string | null = null
      try {
        ownerEmail = getAgentMailSettings().owner
      } catch {}
      errors.push(...checkPreferCtxEmailForSelfGmail(code, path, { ownerEmail }))
    } catch {}

    return {
      ok: errors.length === 0,
      errors,
      definition: errors.length === 0 ? mod.default : undefined,
    }
  } catch (e: any) {
    return {
      ok: false,
      errors: [{ field: "import", message: `Failed to import jig: ${e?.message ?? String(e)}` }],
    }
  }
}

/**
 * Validate a JigDefinition object directly (without importing a file).
 * Used after code generation to check the definition before writing to disk.
 */
export function validateDefinitionObject(def: unknown): ValidationResult {
  const errors = validateDefinition(def)
  return {
    ok: errors.length === 0,
    errors,
    definition: errors.length === 0 ? def as JigDefinition : undefined,
  }
}

// ---------------------------------------------------------------------------
// CLI: bun run src/validate.ts <path>
// ---------------------------------------------------------------------------

if (import.meta.main) {
  const path = process.argv[2]
  if (!path) {
    console.error("Usage: bun run src/validate.ts <jig-file.ts>")
    process.exit(1)
  }

  const absPath = path.startsWith("/") ? path : `${PROJECT_ROOT}/${path}`
  const result = await validateJigFile(absPath)

  if (result.ok) {
    console.log(`✓ ${path} is valid`)
    if (result.definition) {
      const trigger = result.definition.options.trigger
      console.log(`  name: ${result.definition.name}`)
      console.log(`  trigger: ${trigger ? `${trigger.type}${trigger.type === "cron" ? ` (${trigger.cron})` : ""}` : "none"}`)
      console.log(`  tools: ${(result.definition.options.tools ?? []).length}`)
    }
  } else {
    console.error(`✗ ${path} has errors:`)
    for (const e of result.errors) {
      console.error(`  ${e.field}: ${e.message}`)
    }
    process.exit(1)
  }
}

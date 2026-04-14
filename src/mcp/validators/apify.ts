import ts from "typescript"
import type {
  ConnectorBuildTimePolicyIssue,
  ConnectorBuildTimeValidationInput,
} from "./types.js"

export function validateApifyBuildTimeResolution(
  input: ConnectorBuildTimeValidationInput
): ConnectorBuildTimePolicyIssue[] {
  const { code, resolution } = input
  const issues: ConnectorBuildTimePolicyIssue[] = []
  const source = ts.createSourceFile("jig.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const variableInitializers = collectVariableInitializers(source)
  const apifyCallArguments = collectConnectionToolCallArguments(source, "apify", "call_actor", variableInitializers)

  if (
    resolution.resolvedTarget
    && codeUsesConnectionTool(code, "apify", "call-actor")
    && !codeUsesResolvedApifyActor(code, resolution.resolvedTarget)
  ) {
    issues.push({
      message: `Build-time discovery resolved the Apify actor to "${resolution.resolvedTarget}". This code must call that exact actor instead of substituting a different one or a placeholder.`,
    })
  }

  if (apifyCallArguments.length === 0) return issues

  if (apifyCallArguments.some((call) => hasObjectProperty(call, "actorId"))) {
    issues.push({
      message: "Use apify.call_actor with the MCP tool's exact params: pass `actor`, not `actorId`.",
    })
  }

  if (apifyCallArguments.some((call) => !hasObjectProperty(call, "input"))) {
    issues.push({
      message: "Use apify.call_actor with the MCP tool's exact params: include an `input` object.",
    })
  }

  if (apifyCallArguments.some((call) => usesInvalidApifyInputValue(getObjectProperty(call, "input"), variableInitializers))) {
    issues.push({
      message: "Use apify.call_actor with a real object for `input`. Do not pass JSON strings or JSON.stringify(...).",
    })
  }

  const requiredInputFields = getRequiredInputFields(resolution.resolvedInputSchema)
  if (requiredInputFields.length === 0) return issues

  const missing = requiredInputFields.filter((field) =>
    !apifyCallArguments.some((call) => objectContainsProperty(getObjectProperty(call, "input"), field, variableInitializers))
  )
  if (missing.length > 0) {
    issues.push({
      message: `Build-time discovery resolved required Apify actor input fields: ${missing.join(", ")}. The apify.call_actor input must provide them directly or map them from jig params/context.`,
    })
  }

  return issues
}

function codeUsesConnectionTool(code: string, serverName: string, toolName: string): boolean {
  const identifier = toolNameToIdentifier(toolName)
  const escapedServer = escapeRegExp(serverName)
  const escapedIdentifier = escapeRegExp(identifier)
  const escapedToolName = escapeRegExp(toolName)
  return (
    new RegExp(`\\b${escapedServer}\\.${escapedIdentifier}\\b`).test(code)
    || new RegExp(`\\b${escapedServer}\\[(["'])${escapedToolName}\\1\\]`).test(code)
  )
}

function toolNameToIdentifier(name: string): string {
  return name
    .replace(/[^A-Za-z0-9_$]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "") || "tool"
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function codeUsesResolvedApifyActor(code: string, actorName: string): boolean {
  const escapedActor = escapeRegExp(actorName)
  return (
    new RegExp(`\\bactor(Id)?\\s*:\\s*["']${escapedActor}["']`).test(code)
    || new RegExp(`\\bapify\\.call_actor\\s*\\(\\s*\\{[\\s\\S]*?["']${escapedActor}["']`, "m").test(code)
  )
}

function collectVariableInitializers(source: ts.SourceFile): Map<string, ts.Expression> {
  const initializers = new Map<string, ts.Expression>()

  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      initializers.set(node.name.text, node.initializer)
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return initializers
}

function collectConnectionToolCallArguments(
  source: ts.SourceFile,
  serverName: string,
  toolIdentifier: string,
  variableInitializers: Map<string, ts.Expression>
): ts.ObjectLiteralExpression[] {
  const calls: ts.ObjectLiteralExpression[] = []

  const visit = (node: ts.Node) => {
    if (
      ts.isCallExpression(node)
      && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression)
      && node.expression.expression.text === serverName
      && node.expression.name.text === toolIdentifier
    ) {
      const resolved = resolveObjectExpression(node.arguments[0], variableInitializers)
      if (resolved) calls.push(resolved)
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return calls
}

function resolveObjectExpression(
  expression: ts.Expression | undefined,
  variableInitializers: Map<string, ts.Expression>,
  seen = new Set<string>()
): ts.ObjectLiteralExpression | null {
  if (!expression) return null
  if (ts.isParenthesizedExpression(expression)) {
    return resolveObjectExpression(expression.expression, variableInitializers, seen)
  }
  if (ts.isAsExpression(expression) || ts.isTypeAssertionExpression(expression)) {
    return resolveObjectExpression(expression.expression, variableInitializers, seen)
  }
  if (ts.isObjectLiteralExpression(expression)) return expression
  if (ts.isIdentifier(expression)) {
    if (seen.has(expression.text)) return null
    seen.add(expression.text)
    return resolveObjectExpression(variableInitializers.get(expression.text), variableInitializers, seen)
  }
  return null
}

function getObjectProperty(node: ts.ObjectLiteralExpression, propertyName: string): ts.Expression | null {
  for (const property of node.properties) {
    if (ts.isPropertyAssignment(property)) {
      const name = getPropertyNameText(property.name)
      if (name === propertyName) return property.initializer
      continue
    }
    if (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName) {
      return property.name
    }
  }
  return null
}

function hasObjectProperty(node: ts.ObjectLiteralExpression, propertyName: string): boolean {
  return getObjectProperty(node, propertyName) !== null
}

function getPropertyNameText(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text
  return null
}

function usesInvalidApifyInputValue(expression: ts.Expression | null, variableInitializers: Map<string, ts.Expression>): boolean {
  if (!expression) return false
  if (ts.isIdentifier(expression)) {
    const resolved = resolveObjectExpression(expression, variableInitializers)
    if (resolved) return false
    const initializer = variableInitializers.get(expression.text)
    if (!initializer || initializer === expression) return false
    return usesInvalidApifyInputValue(initializer, variableInitializers)
  }
  if (ts.isStringLiteralLike(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) return true
  if (
    ts.isCallExpression(expression)
    && ts.isPropertyAccessExpression(expression.expression)
    && ts.isIdentifier(expression.expression.expression)
    && expression.expression.expression.text === "JSON"
    && expression.expression.name.text === "stringify"
  ) {
    return true
  }
  return false
}

function objectContainsProperty(
  expression: ts.Expression | null,
  propertyName: string,
  variableInitializers: Map<string, ts.Expression>
): boolean {
  if (!expression) return false
  const resolved = resolveObjectExpression(expression, variableInitializers)
  if (resolved) {
    return resolved.properties.some((property) =>
      (ts.isPropertyAssignment(property) && getPropertyNameText(property.name) === propertyName)
      || (ts.isShorthandPropertyAssignment(property) && property.name.text === propertyName)
    )
  }
  return false
}

function getRequiredInputFields(schema: unknown): string[] {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return []
  const record = schema as Record<string, unknown>
  if (record.type !== "object") return []
  const required = Array.isArray(record.required) ? record.required : []
  return required.filter((field): field is string => typeof field === "string")
}

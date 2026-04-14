import { AsyncLocalStorage } from "node:async_hooks"

/** Per-run context for dry-run state. */
export const dryRunContext = new AsyncLocalStorage<boolean>()

const DRY_RUN_PLACEHOLDER_PREFIX = "__jig_dry_run__:"

/**
 * Check if the current execution is a dry run.
 * Reads from per-run AsyncLocalStorage context first, falls back to global.
 */
export function isDryRun(): boolean {
  return dryRunContext.getStore() ?? _dryRun
}

// Global fallback — used by CLI (setDryRun before runJig) and tests
let _dryRun = process.env.JIG_DRY_RUN === "1"

export function setDryRun(v: boolean) {
  _dryRun = v
  if (v) process.env.JIG_DRY_RUN = "1"
  else delete process.env.JIG_DRY_RUN
}

export function shouldStubToolInDryRun(params: unknown): boolean {
  return containsDryRunPlaceholder(params)
}

export function buildDryRunToolResult(
  toolName: string,
  params: Record<string, unknown> | undefined,
  outputSchema: unknown,
  readOnly: boolean
): unknown {
  const synthetic = synthesizeFromSchema(outputSchema, toolName, [])

  if (synthetic && typeof synthetic === "object" && !Array.isArray(synthetic)) {
    return {
      ...synthetic,
      _dryRun: true,
      tool: toolName,
      params: params ?? {},
      readOnly,
    }
  }

  return synthetic ?? { _dryRun: true, tool: toolName, params: params ?? {}, readOnly }
}

function containsDryRunPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith(DRY_RUN_PLACEHOLDER_PREFIX)
  if (Array.isArray(value)) return value.some((item) => containsDryRunPlaceholder(item))
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((nested) => containsDryRunPlaceholder(nested))
  }
  return false
}

function synthesizeFromSchema(schema: unknown, toolName: string, path: string[]): unknown {
  if (!schema || typeof schema !== "object") return undefined
  const typedSchema = schema as Record<string, unknown>
  const schemaType = typeof typedSchema.type === "string" ? typedSchema.type : undefined

  if (schemaType === "object") {
    const properties = typedSchema.properties
    if (!properties || typeof properties !== "object") return {}
    const entries = Object.entries(properties as Record<string, unknown>).map(([key, childSchema]) => [
      key,
      synthesizeFromSchema(childSchema, toolName, [...path, key]),
    ])
    return Object.fromEntries(entries)
  }

  if (schemaType === "array") {
    return []
  }

  if (schemaType === "string") {
    const leaf = path[path.length - 1] ?? "value"
    return `${DRY_RUN_PLACEHOLDER_PREFIX}${toolName}:${leaf}`
  }

  if (schemaType === "integer" || schemaType === "number") {
    return 0
  }

  if (schemaType === "boolean") {
    return false
  }

  if (Array.isArray(typedSchema.enum) && typedSchema.enum.length > 0) {
    return typedSchema.enum[0]
  }

  return undefined
}

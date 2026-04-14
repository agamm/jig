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
  return containsDryRunPlaceholder(params) || containsUndefinedValue(params) || containsDryRunMarker(params)
}

export function buildDryRunToolResult(
  toolName: string,
  params: Record<string, unknown> | undefined,
  readOnly: boolean
): unknown {
  return { _dryRun: true, tool: toolName, params: params ?? {}, readOnly }
}

function containsDryRunPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return value.startsWith(DRY_RUN_PLACEHOLDER_PREFIX)
  if (Array.isArray(value)) return value.some((item) => containsDryRunPlaceholder(item))
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((nested) => containsDryRunPlaceholder(nested))
  }
  return false
}

function containsUndefinedValue(value: unknown): boolean {
  if (value === undefined) return true
  if (Array.isArray(value)) return value.some((item) => containsUndefinedValue(item))
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((nested) => containsUndefinedValue(nested))
  }
  return false
}

function containsDryRunMarker(value: unknown): boolean {
  if (!value || typeof value !== "object") return false
  if (Array.isArray(value)) return value.some((item) => containsDryRunMarker(item))
  const record = value as Record<string, unknown>
  if (record._dryRun === true) return true
  return Object.values(record).some((nested) => containsDryRunMarker(nested))
}

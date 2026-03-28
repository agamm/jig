import { AsyncLocalStorage } from "node:async_hooks"

/** Per-run context for dry-run state. */
export const dryRunContext = new AsyncLocalStorage<boolean>()

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

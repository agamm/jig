/**
 * Instance-wide administration: model slot overrides and the destructive
 * local-state reset.
 */
import { existsSync, readdirSync, rmSync } from "fs"
import { MODEL_SLOTS, type ModelSlot } from "../../../shared/api.js"
import { closeDb, listCredentials, openDb } from "../../db.js"
import { ApiError, apiJson } from "../http.js"
import { CONNECTIONS_DIR, DB_PATH, RUNTIME_DIR, SCHEMAS_DIR, TYPES_DIR } from "../../config/paths.js"
import { isServiceMode } from "../../config/runtime.js"
import { announceSetupCode, clearSetupCode } from "../../auth/setup-code.js"
import { closeAllConnections } from "../../mcp/client.js"
import { listJigs as storeListJigs } from "../../services/jig-store.js"

export function parseSlot(value: unknown): ModelSlot {
  if (typeof value === "string" && (MODEL_SLOTS as readonly string[]).includes(value)) {
    return value as ModelSlot
  }
  throw new ApiError(400, `slot must be one of: ${MODEL_SLOTS.join(", ")}`)
}

export function parseModelId(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "modelId is required")
  }
  return value.trim()
}

/** Wipes every trace of this instance: jigs, history, credentials, and the
 *  generated MCP artifacts. The dashboard gates this behind a confirmation. */
export async function handleResetLocalState(): Promise<Response> {
  const disconnectedConnections = [...new Set([
    ...listCredentials().map((row) => row.server),
    ...(existsSync(SCHEMAS_DIR)
      ? readdirSync(SCHEMAS_DIR).filter((name) => name.endsWith(".json")).map((name) => name.replace(/\.json$/, ""))
      : []),
  ])].sort()

  // Read everything we need to report BEFORE closing. Any store call reopens the
  // singleton, and a handle open across the unlink below survives as an orphaned
  // vnode — every later query then fails with SQLITE_IOERR until the process
  // restarts. Deleting the file is what removes the jigs; no per-row delete.
  const deletedJigs = storeListJigs().map((j) => j.id)

  await closeAllConnections()
  closeDb()

  for (const ext of ["", "-shm", "-wal"]) {
    rmSync(`${DB_PATH}${ext}`, { force: true })
  }

  // Remove generated local MCP artifacts too so onboarding is truly fresh.
  rmSync(SCHEMAS_DIR, { recursive: true, force: true })
  rmSync(TYPES_DIR, { recursive: true, force: true })
  rmSync(CONNECTIONS_DIR, { recursive: true, force: true })
  // Materialized version files are keyed by {jigId}-{versionId}; version ids
  // restart after the database is wiped, so leaving these behind would let a
  // re-created jig import stale code.
  rmSync(RUNTIME_DIR, { recursive: true, force: true })

  openDb()

  // The reset wiped the password + session secret, so the instance is unclaimed
  // again. In service mode, mint & print a fresh setup code so the operator can
  // re-claim it — otherwise setup-password would demand a code that was never
  // generated (deadlock).
  if (isServiceMode()) {
    clearSetupCode()
    announceSetupCode()
  }

  return apiJson("resetLocalState", { ok: true, deletedJigs, disconnectedConnections })
}

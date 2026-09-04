/**
 * Jig version routes — the pending/approve/discard/restore lifecycle and the
 * version list the dashboard's history pane renders.
 *
 * Approval is a pointer move in the store (see services/jig-store.ts): the
 * pending version becomes active. Nothing here writes jig source to disk.
 */
import { ApiError, apiJson } from "../http.js"
import {
  approvePending as approveJigPending,
  discardPending as discardJigPending,
  getActiveVersion as getJigActiveVersion,
  getJigRow,
  getPending as getJigPending,
  getVersion as getJigVersion,
  listHistoryVersions as listJigHistoryVersions,
  restoreVersion as restoreToPendingVersion,
  writePending as storeWritePending,
  type JigVersion as JigVersionStoreRow,
} from "../../services/jig-store.js"
import { hasActiveRunForJig } from "../../services/run-store.js"
import { materializePendingVersion } from "../../services/jig-runtime.js"
import { checkJigFile } from "../../services/jig-checker.js"

function jigVersionToRecord(v: JigVersionStoreRow) {
  return {
    id: v.id,
    jigId: v.jigId,
    author: v.author,
    message: v.message,
    prompt: v.prompt,
    parentVersionId: v.parentVersionId,
    createdAt: v.createdAt,
  }
}

function ensureJigStoreRow(jigId: string): void {
  if (!getJigRow(jigId)) throw new ApiError(404, `Jig not found: ${jigId}`)
}

/**
 * Direct code write, the path a coding agent uses when it wrote the jig itself.
 * Creates the jig when it does not exist yet, stores the code as the pending
 * version, checks it the way draft approval does (tsc, validator, step
 * structure), and promotes it only when asked AND the check is clean. Drafts
 * may be wrong; the active version may not.
 */
export async function handleWriteJigCode(
  jigId: string,
  body: { code?: unknown; message?: unknown; approve?: unknown },
): Promise<Response> {
  if (typeof body.code !== "string" || body.code.trim().length === 0) throw new ApiError(400, "code is required")
  if (hasActiveRunForJig(jigId)) throw new ApiError(409, "Cannot edit while the jig is running")
  const { approvePendingByJig, findDisconnectedImports, isJigBeingEdited } = await import("../../services/agent-service.js")
  if (isJigBeingEdited(jigId)) {
    throw new ApiError(409, "An authoring session is currently editing this jig; close that session before scripted edits")
  }
  const disconnected = findDisconnectedImports(body.code)
  if (disconnected.length > 0) {
    throw new ApiError(400, `Code imports unconnected servers: ${disconnected.join(", ")}. Connect them first via the dashboard.`)
  }

  const created = !getJigRow(jigId)
  const message = typeof body.message === "string" ? body.message : null
  const { versionId } = storeWritePending({ jigId, code: body.code, author: "cli", message, prompt: null })

  // The checker needs a real file: tsc builds a program from a path and the
  // validator imports the module. Same recipe as prepareDraftApproval.
  const materialized = await materializePendingVersion(jigId)
  const result = materialized ? await checkJigFile(materialized.path) : "Could not materialize the pending version for checking"
  const check = result === "ok" ? [] : result.split("\n")

  let activeVersionId: number | null = null
  if (body.approve === true && check.length === 0) {
    await approvePendingByJig(jigId)
    activeVersionId = getJigRow(jigId)?.active_version_id ?? null
  }
  return apiJson("writeJigCode", { ok: true as const, created, pendingVersionId: versionId, activeVersionId, check })
}

export function handleGetPending(jigId: string): Response {
  // Pending may exist on a brand-new jig that doesn't yet have a `jigs/{id}.ts`
  // file — so we DON'T call ensureJigExists here. The store row is enough.
  if (!getJigRow(jigId)) return apiJson("getPending", null)
  return apiJson("getPending", getJigPending(jigId))
}

export async function handleApprovePending(jigId: string): Promise<Response> {
  ensureJigStoreRow(jigId)
  if (hasActiveRunForJig(jigId)) {
    throw new ApiError(409, "Cannot approve a pending change while the jig is running")
  }
  if (!getJigPending(jigId)) throw new ApiError(404, "No pending changes")
  const { activeVersionId } = approveJigPending(jigId)
  return apiJson("approvePending", { ok: true as const, jigId, activeVersionId })
}

export function handleDiscardPending(jigId: string): Response {
  ensureJigStoreRow(jigId)
  if (!getJigPending(jigId)) {
    return apiJson("discardPending", { ok: true as const, jigId })
  }
  discardJigPending(jigId)
  return apiJson("discardPending", { ok: true as const, jigId })
}

export async function handleRestoreToPending(jigId: string, body: { versionId?: unknown }): Promise<Response> {
  ensureJigStoreRow(jigId)
  if (hasActiveRunForJig(jigId)) {
    throw new ApiError(409, "Cannot restore while the jig is running")
  }
  const versionId = typeof body.versionId === "number" ? body.versionId : NaN
  if (!Number.isFinite(versionId)) throw new ApiError(400, "Missing or invalid versionId")
  const source = getJigVersion(versionId)
  if (!source || source.jigId !== jigId) throw new ApiError(404, "Version not found")
  if (getJigPending(jigId)) {
    throw new ApiError(409, "A pending change already exists — approve or discard it before restoring an older version")
  }
  const { pendingVersionId } = restoreToPendingVersion({ jigId, versionId })
  return apiJson("restoreToPending", { ok: true as const, jigId, pendingVersionId })
}

export function handleListVersionsV2(jigId: string): Response {
  const row = getJigRow(jigId)
  if (!row) return apiJson("listVersionsV2", { active: null, pending: null, history: [] })
  const active = getJigActiveVersion(jigId)
  const pending = row.pending_version_id != null ? getJigVersion(row.pending_version_id) : null
  const history = listJigHistoryVersions(jigId).filter((v) => v.id !== active?.id)
  return apiJson("listVersionsV2", {
    active: active ? jigVersionToRecord(active) : null,
    pending: pending ? jigVersionToRecord(pending) : null,
    history: history.map(jigVersionToRecord),
  })
}

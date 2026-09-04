/**
 * Single source of truth for jig source code.
 *
 * Two tables: `jigs` and `jig_versions`. Each jig points at its `active_version`
 * (what runs) and optionally a `pending_version` (proposed but unapproved).
 * Approve moves the active pointer to pending. Discard hard-deletes the pending
 * row. Restore writes a new pending carrying the old code.
 *
 * Code is a stream of versions; everything else is plumbing.
 */
import { Database } from "bun:sqlite"
import { createTwoFilesPatch, diffLines } from "diff"
import { openDb } from "../db.js"

// ---------------------------------------------------------------------------
// Row + public types
// ---------------------------------------------------------------------------

export type VersionAuthor = "agent" | "restore" | "import" | "cli"

export interface JigRow {
  id: string
  name: string
  active_version_id: number | null
  pending_version_id: number | null
  created_at: number
  archived_at: number | null
}

export interface JigVersionRow {
  id: number
  jig_id: string
  code: string
  message: string | null
  prompt: string | null
  author: VersionAuthor
  parent_version_id: number | null
  created_at: number
}

export interface JigVersion {
  id: number
  jigId: string
  code: string
  message: string | null
  prompt: string | null
  author: VersionAuthor
  parentVersionId: number | null
  createdAt: number
}

export interface JigSummary {
  id: string
  name: string
  activeVersionId: number | null
  pendingVersionId: number | null
  hasPending: boolean
  createdAt: number
}

export interface PendingState {
  versionId: number
  code: string
  publishedCode: string  // active version's code, or "" if jig is brand-new
  diff: string           // unified diff string
  addedLines: number
  removedLines: number
  author: VersionAuthor
  prompt: string | null
  message: string | null
  createdAt: number
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function rowToVersion(row: JigVersionRow): JigVersion {
  return {
    id: row.id,
    jigId: row.jig_id,
    code: row.code,
    message: row.message,
    prompt: row.prompt,
    author: row.author,
    parentVersionId: row.parent_version_id,
    createdAt: row.created_at,
  }
}

function rowToSummary(row: JigRow): JigSummary {
  return {
    id: row.id,
    name: row.name,
    activeVersionId: row.active_version_id,
    pendingVersionId: row.pending_version_id,
    hasPending: row.pending_version_id != null,
    createdAt: row.created_at,
  }
}

function countDiff(oldCode: string, newCode: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  // diffLines always populates `count` for line-mode parts.
  for (const part of diffLines(oldCode, newCode)) {
    if (part.added) added += part.count ?? 0
    else if (part.removed) removed += part.count ?? 0
  }
  return { added, removed }
}

function unifiedDiff(jigId: string, oldCode: string, newCode: string): string {
  return createTwoFilesPatch(`${jigId}.ts (active)`, `${jigId}.ts (pending)`, oldCode, newCode, undefined, undefined, { context: 3 })
}

function insertVersion(
  db: Database,
  args: { jigId: string; code: string; author: VersionAuthor; message?: string | null; prompt?: string | null; parentId: number | null },
): number {
  const result = db
    .prepare(
      `INSERT INTO jig_versions (jig_id, code, message, prompt, author, parent_version_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(args.jigId, args.code, args.message ?? null, args.prompt ?? null, args.author, args.parentId, Date.now())
  return Number(result.lastInsertRowid)
}

// ---------------------------------------------------------------------------
// Public queries
// ---------------------------------------------------------------------------

export function getJigRow(jigId: string): JigRow | null {
  return openDb().prepare(`SELECT * FROM jigs WHERE id = ?`).get(jigId) as JigRow | null
}

export function listJigs(): JigSummary[] {
  return (openDb()
    .prepare(`SELECT * FROM jigs WHERE archived_at IS NULL ORDER BY created_at DESC`)
    .all() as JigRow[]).map(rowToSummary)
}

export function getVersion(versionId: number): JigVersion | null {
  const row = openDb().prepare(`SELECT * FROM jig_versions WHERE id = ?`).get(versionId) as JigVersionRow | null
  return row ? rowToVersion(row) : null
}

/** All versions for a jig in newest-first order, including pending if present. */
export function listAllVersions(jigId: string): JigVersion[] {
  return (openDb()
    .prepare(`SELECT * FROM jig_versions WHERE jig_id = ? ORDER BY id DESC`)
    .all(jigId) as JigVersionRow[]).map(rowToVersion)
}

/** Versions excluding pending — for the versions panel "history" list. */
export function listHistoryVersions(jigId: string): JigVersion[] {
  const jig = getJigRow(jigId)
  if (!jig) return []
  return (openDb()
    .prepare(`SELECT * FROM jig_versions WHERE jig_id = ? AND id IS NOT ? ORDER BY id DESC`)
    .all(jigId, jig.pending_version_id) as JigVersionRow[]).map(rowToVersion)
}

export function getActiveCode(jigId: string): string | null {
  const jig = getJigRow(jigId)
  if (!jig?.active_version_id) return null
  const row = openDb()
    .prepare(`SELECT code FROM jig_versions WHERE id = ?`)
    .get(jig.active_version_id) as { code: string } | null
  return row?.code ?? null
}

export function getActiveVersion(jigId: string): JigVersion | null {
  const jig = getJigRow(jigId)
  if (!jig?.active_version_id) return null
  return getVersion(jig.active_version_id)
}

export function getPending(jigId: string): PendingState | null {
  const jig = getJigRow(jigId)
  if (!jig?.pending_version_id) return null
  const pending = getVersion(jig.pending_version_id)
  if (!pending) return null
  const published = getActiveCode(jigId) ?? ""
  const { added, removed } = countDiff(published, pending.code)
  return {
    versionId: pending.id,
    code: pending.code,
    publishedCode: published,
    diff: unifiedDiff(jigId, published, pending.code),
    addedLines: added,
    removedLines: removed,
    author: pending.author,
    prompt: pending.prompt,
    message: pending.message,
    createdAt: pending.createdAt,
  }
}

// ---------------------------------------------------------------------------
// Mutations (all atomic via db.transaction)
// ---------------------------------------------------------------------------

/**
 * Write a pending version for a jig. If the jig row doesn't exist yet, creates it
 * (no active set — only pending). If a pending already exists, the old pending row
 * is hard-deleted and replaced; agent iterations during a session don't pollute history.
 */
export function writePending(args: {
  jigId: string
  name?: string
  code: string
  author: VersionAuthor
  message?: string | null
  prompt?: string | null
}): { versionId: number; pendingReplaced: boolean } {
  const db = openDb()
  let versionId = 0
  let pendingReplaced = false

  db.transaction(() => {
    let jig = getJigRow(args.jigId)
    if (!jig) {
      // brand new jig — create row with no active
      db.prepare(`INSERT INTO jigs (id, name, created_at) VALUES (?, ?, ?)`)
        .run(args.jigId, args.name ?? args.jigId, Date.now())
      jig = getJigRow(args.jigId)!
    }

    // If a pending exists, replace it. Drafts during one session are scratch.
    if (jig.pending_version_id != null) {
      pendingReplaced = true
      // Null the pointer first so the FK doesn't block the delete.
      db.prepare(`UPDATE jigs SET pending_version_id = NULL WHERE id = ?`).run(args.jigId)
      db.prepare(`DELETE FROM jig_versions WHERE id = ?`).run(jig.pending_version_id)
    }

    versionId = insertVersion(db, {
      jigId: args.jigId,
      code: args.code,
      author: args.author,
      message: args.message,
      prompt: args.prompt,
      parentId: jig.active_version_id,
    })

    db.prepare(`UPDATE jigs SET pending_version_id = ? WHERE id = ?`).run(versionId, args.jigId)
  })()

  return { versionId, pendingReplaced }
}

/** Promote pending to active. Returns the new active versionId. */
export function approvePending(jigId: string): { activeVersionId: number } {
  const db = openDb()
  let activeVersionId = 0
  db.transaction(() => {
    const jig = getJigRow(jigId)
    if (!jig) throw new Error(`Jig not found: ${jigId}`)
    if (jig.pending_version_id == null) throw new Error(`No pending changes for jig: ${jigId}`)
    activeVersionId = jig.pending_version_id
    db.prepare(`UPDATE jigs SET active_version_id = ?, pending_version_id = NULL WHERE id = ?`)
      .run(activeVersionId, jigId)
  })()
  return { activeVersionId }
}

/** Hard-delete the pending version. The row never went live so it leaves no trace. */
export function discardPending(jigId: string): void {
  const db = openDb()
  db.transaction(() => {
    const jig = getJigRow(jigId)
    if (!jig?.pending_version_id) return
    const pendingId = jig.pending_version_id
    db.prepare(`UPDATE jigs SET pending_version_id = NULL WHERE id = ?`).run(jigId)
    db.prepare(`DELETE FROM jig_versions WHERE id = ?`).run(pendingId)

    // If the jig is brand-new (no active was ever set), the jig row itself is
    // also dead weight — drop it. This makes "discard during creation" symmetric
    // with "never started the jig at all".
    if (jig.active_version_id == null) {
      db.prepare(`DELETE FROM jigs WHERE id = ?`).run(jigId)
    }
  })()
}

/**
 * Restore an old version. Writes a new pending row whose code copies the old version.
 * Errors if a pending already exists — user must approve or discard first.
 */
export function restoreVersion(args: { jigId: string; versionId: number; author?: VersionAuthor }): { pendingVersionId: number } {
  const db = openDb()
  let pendingVersionId = 0
  db.transaction(() => {
    const jig = getJigRow(args.jigId)
    if (!jig) throw new Error(`Jig not found: ${args.jigId}`)
    if (jig.pending_version_id != null) {
      throw new Error("A pending change already exists — approve or discard it before restoring an older version")
    }
    const source = getVersion(args.versionId)
    if (!source || source.jigId !== args.jigId) throw new Error(`Version not found: ${args.versionId}`)

    pendingVersionId = insertVersion(db, {
      jigId: args.jigId,
      code: source.code,
      author: args.author ?? "restore",
      message: `restore from version ${args.versionId}`,
      prompt: source.prompt,
      parentId: args.versionId,
    })
    db.prepare(`UPDATE jigs SET pending_version_id = ? WHERE id = ?`).run(pendingVersionId, args.jigId)
  })()
  return { pendingVersionId }
}

/** Rename a jig. All version FK pointers cascade, and every version's code is
 *  rewritten so the literal `jig("oldId")` references match the new id —
 *  otherwise restoring a pre-rename version would refer to a dead identifier.
 *  All in one transaction. */
export function renameJig(oldId: string, newId: string): void {
  if (oldId === newId) return
  const db = openDb()
  db.transaction(() => {
    const existing = getJigRow(newId)
    if (existing) throw new Error(`Jig already exists: ${newId}`)

    // Rewrite the jig("...") identifier inside every version's code. The
    // capture-group preserves whatever quote character the user used.
    const rows = db.prepare(`SELECT id, code FROM jig_versions WHERE jig_id = ?`).all(oldId) as { id: number; code: string }[]
    const update = db.prepare(`UPDATE jig_versions SET code = ? WHERE id = ?`)
    for (const row of rows) {
      const rewritten = row.code.replace(/jig\(\s*(["'`])([^"'`]+)\1/, (match, quote: string, name: string) =>
        name === oldId ? `jig(${quote}${newId}${quote}` : match,
      )
      if (rewritten !== row.code) update.run(rewritten, row.id)
    }

    db.prepare(`UPDATE jig_versions SET jig_id = ? WHERE jig_id = ?`).run(newId, oldId)
    db.prepare(`UPDATE jigs SET id = ? WHERE id = ?`).run(newId, oldId)
  })()
}

/** Hard delete a jig and all its versions. */
export function deleteJig(jigId: string): void {
  const db = openDb()
  db.transaction(() => {
    db.prepare(`UPDATE jigs SET active_version_id = NULL, pending_version_id = NULL WHERE id = ?`).run(jigId)
    db.prepare(`DELETE FROM jig_versions WHERE jig_id = ?`).run(jigId)
    db.prepare(`DELETE FROM jigs WHERE id = ?`).run(jigId)
  })()
}

/**
 * Remove creation-draft jig rows no session can reach anymore: never approved
 * (no active version) and no agent session referencing them. Such orphans are
 * invisible in the UI but still claim their id, so the next create attempt for
 * the same request errors "Jig already exists" and the authoring agent invents
 * a duplicate variant name. Returns the removed jig ids.
 */
export function sweepOrphanedDraftJigs(): string[] {
  const db = openDb()
  const rows = db.prepare(`
    SELECT j.id FROM jigs j
    WHERE j.active_version_id IS NULL
      AND NOT EXISTS (SELECT 1 FROM agent_sessions s WHERE s.jig_id = j.id)
  `).all() as { id: string }[]
  for (const row of rows) deleteJig(row.id)
  return rows.map((r) => r.id)
}

/**
 * Import path — used by the migration to ingest pre-rehaul `jigs/*.ts` files into
 * the new tables. Each call appends one version. The caller chains parent_version_id
 * to preserve the git history order. After importing all commits for a jig, call
 * `setActiveVersion` to point active at the latest.
 */
export function importVersion(args: {
  jigId: string
  name: string
  code: string
  message?: string | null
  prompt?: string | null
  parentId: number | null
  createdAt: number
}): { versionId: number } {
  const db = openDb()
  let versionId = 0
  db.transaction(() => {
    if (!getJigRow(args.jigId)) {
      db.prepare(`INSERT INTO jigs (id, name, created_at) VALUES (?, ?, ?)`)
        .run(args.jigId, args.name, args.createdAt)
    }
    const result = db
      .prepare(
        `INSERT INTO jig_versions (jig_id, code, message, prompt, author, parent_version_id, created_at)
         VALUES (?, ?, ?, ?, 'import', ?, ?)`,
      )
      .run(args.jigId, args.code, args.message ?? null, args.prompt ?? null, args.parentId, args.createdAt)
    versionId = Number(result.lastInsertRowid)
  })()
  return { versionId }
}

export function setActiveVersion(jigId: string, versionId: number): void {
  openDb().prepare(`UPDATE jigs SET active_version_id = ? WHERE id = ?`).run(versionId, jigId)
}

/**
 * Materializes jig code from the DB to disk so Bun can `import()` it.
 *
 * Active code lives in jig_versions; the runtime needs a file path. We write
 * each version to `${DATA_DIR}/runtime/{jigId}-{versionId}.ts`. The versionId
 * in the path means each version is a distinct module specifier — Bun's import
 * cache stays correct across approve/restore without manual invalidation.
 *
 * Old version files are swept on a schedule (keep only the current active).
 */
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "fs"
import { join } from "path"
import { RUNTIME_DIR } from "../config/paths.js"
import { getActiveVersion, getJigRow, getVersion, listJigs, type JigVersion } from "./jig-store.js"

function ensureRuntimeDir(): void {
  if (!existsSync(RUNTIME_DIR)) mkdirSync(RUNTIME_DIR, { recursive: true })
}

function pathFor(jigId: string, versionId: number): string {
  return join(RUNTIME_DIR, `${jigId}-${versionId}.ts`)
}

async function writeIfMissing(path: string, code: string): Promise<void> {
  if (existsSync(path)) return
  await Bun.write(path, code)
}

/**
 * Materializes a specific version. Returns the path Bun can import.
 */
export async function materializeVersion(version: JigVersion): Promise<string> {
  ensureRuntimeDir()
  const path = pathFor(version.jigId, version.id)
  await writeIfMissing(path, version.code)
  return path
}

/**
 * Materializes the active version of a jig. Returns null if the jig has no active
 * version (brand-new draft that hasn't been approved yet).
 */
export async function materializeActiveVersion(jigId: string): Promise<{ path: string; versionId: number } | null> {
  const active = getActiveVersion(jigId)
  if (!active) return null
  const path = await materializeVersion(active)
  return { path, versionId: active.id }
}

/**
 * Materializes any version by id (for example, when running a specific historical version).
 */
export async function materializeVersionById(versionId: number): Promise<string | null> {
  const version = getVersion(versionId)
  if (!version) return null
  return materializeVersion(version)
}

/**
 * Materializes the pending version of a jig. Returns null if no pending exists.
 * Used during agent flows that need the file on disk for introspection / typecheck.
 */
export async function materializePendingVersion(jigId: string): Promise<{ path: string; versionId: number } | null> {
  const jig = getJigRow(jigId)
  if (!jig?.pending_version_id) return null
  const v = getVersion(jig.pending_version_id)
  if (!v) return null
  const path = await materializeVersion(v)
  return { path, versionId: v.id }
}

/**
 * Sweep stale files from the runtime cache. Keeps only the current active version
 * file per jig. Safe to call on a timer or at server start.
 */
export function gcRuntimeCache(): { removed: number; kept: number } {
  if (!existsSync(RUNTIME_DIR)) return { removed: 0, kept: 0 }

  const keep = new Set<string>()
  for (const jig of listJigs()) {
    if (jig.activeVersionId != null) keep.add(`${jig.id}-${jig.activeVersionId}.ts`)
  }

  let removed = 0
  let kept = 0
  for (const name of readdirSync(RUNTIME_DIR)) {
    if (!name.endsWith(".ts")) continue
    if (keep.has(name)) { kept++; continue }
    try {
      rmSync(join(RUNTIME_DIR, name), { force: true })
      removed++
    } catch {
      // best-effort; another process may have already removed it
    }
  }
  return { removed, kept }
}

/**
 * Returns the size in bytes of the runtime cache, for diagnostics.
 */
export function runtimeCacheStats(): { files: number; bytes: number } {
  if (!existsSync(RUNTIME_DIR)) return { files: 0, bytes: 0 }
  let files = 0
  let bytes = 0
  for (const name of readdirSync(RUNTIME_DIR)) {
    if (!name.endsWith(".ts")) continue
    files++
    try { bytes += statSync(join(RUNTIME_DIR, name)).size } catch {}
  }
  return { files, bytes }
}

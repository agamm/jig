/**
 * Jig discovery — scans a jigs directory for flat .ts files.
 *
 * - File in jigs/          → jig (name from filename)
 * - _ prefix               → skipped (helpers, examples)
 *
 * Results are cached in memory with a 5-second TTL.
 *
 * Safety: rejects symlinks and nested .git directories to prevent
 * bare-repo attacks and symlink escapes in user-authored jig files.
 */
import { lstatSync, readdirSync } from "fs"
import { join } from "path"

let _cache: { data: Map<string, string[]>; dir: string; ts: number } | null = null
const CACHE_TTL = 5000

/** Throw if jigs/ contains a nested .git (bare-repo attack) or suspicious symlinks. */
function assertSafeDirectory(jigsDir: string): void {
  let entries: string[]
  try { entries = readdirSync(jigsDir) } catch { return }
  for (const name of entries) {
    if (name === ".git") continue // top-level jigs/.git is expected (version control)
    const full = join(jigsDir, name)
    const stat = lstatSync(full)
    // Reject symlinks — could escape jigs/ sandbox
    if (stat.isSymbolicLink()) {
      throw new Error(`Refusing to load jigs: symlink detected at ${full}`)
    }
    // Reject nested .git directories (bare-repo attack vector)
    if (stat.isDirectory()) {
      try {
        const sub = readdirSync(full)
        if (sub.includes(".git")) {
          throw new Error(`Refusing to load jigs: nested .git found in ${full}`)
        }
      } catch (e: any) {
        if (e?.message?.startsWith("Refusing")) throw e
      }
    }
  }
}

export function discoverJigs(jigsDir: string): Map<string, string[]> {
  const now = Date.now()
  if (_cache && _cache.dir === jigsDir && now - _cache.ts < CACHE_TTL) {
    return _cache.data
  }

  assertSafeDirectory(jigsDir)

  const jigs = new Map<string, string[]>()
  const glob = new Bun.Glob("*.ts")
  for (const file of glob.scanSync(jigsDir)) {
    const name = file.replace(".ts", "")
    if (name.startsWith("_")) continue
    jigs.set(name, [])
  }

  _cache = { data: jigs, dir: jigsDir, ts: now }
  return jigs
}

/** Force re-scan on next call (e.g. after creating a new jig). */
export function invalidateJigsCache(): void {
  _cache = null
}

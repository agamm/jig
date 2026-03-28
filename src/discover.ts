/**
 * Jig discovery — scans a jigs directory for single-instance and grouped jigs.
 *
 * - File in jigs/          → single-instance (name from filename, empty entities)
 * - Folder in jigs/        → grouped (name from folder, .ts files = entities)
 * - _ prefix               → skipped (helpers, examples)
 *
 * Results are cached in memory with a 5-second TTL.
 */
let _cache: { data: Map<string, string[]>; dir: string; ts: number } | null = null
const CACHE_TTL = 5000

export function discoverJigs(jigsDir: string): Map<string, string[]> {
  const now = Date.now()
  if (_cache && _cache.dir === jigsDir && now - _cache.ts < CACHE_TTL) {
    return _cache.data
  }

  const jigs = new Map<string, string[]>()
  const glob = new Bun.Glob("**/*.ts")
  for (const file of glob.scanSync(jigsDir)) {
    const parts = file.replace(".ts", "").split("/")
    if (parts.at(-1)!.startsWith("_")) continue
    if (parts.length === 1) {
      jigs.set(parts[0], [])
    } else {
      const [name, entity] = parts
      if (!jigs.has(name)) jigs.set(name, [])
      jigs.get(name)!.push(entity)
    }
  }

  _cache = { data: jigs, dir: jigsDir, ts: now }
  return jigs
}

/** Force re-scan on next call (e.g. after creating a new jig). */
export function invalidateJigsCache(): void {
  _cache = null
}

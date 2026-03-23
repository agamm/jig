/**
 * Jig discovery — scans a jigs directory for single-instance and grouped jigs.
 *
 * - File in jigs/          → single-instance (name from filename, empty entities)
 * - Folder in jigs/        → grouped (name from folder, .ts files = entities)
 * - _ prefix               → skipped (helpers, examples)
 */
export function discoverJigs(jigsDir: string): Map<string, string[]> {
  const jigs = new Map<string, string[]>() // name → entities (empty = single-instance)
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
  return jigs
}

/**
 * Test fixtures for v12: seed the jig store directly so the runner can
 * materialize an active version. Replaces the pre-v12 pattern of writing
 * straight to JIGS_DIR.
 */
import { mkdirSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { approvePending, writePending } from "../src/services/jig-store.js"

/** Seed a jig as an immediately-active version in the store. Returns its id. */
export function seedJig(jigId: string, code: string): string {
  writePending({ jigId, code, author: "cli", message: "test fixture" })
  approvePending(jigId)
  return jigId
}

/**
 * Write a sibling file (helper / import target) into the same tmpdir the
 * runtime-imports rewriter materializes jigs to, so the jig's relative
 * import resolves correctly at exec time.
 */
export function writeRuntimeSibling(filename: string, code: string): string {
  const dir = join(tmpdir(), "jig-runtime")
  mkdirSync(dir, { recursive: true })
  const path = join(dir, filename)
  writeFileSync(path, code)
  return path
}

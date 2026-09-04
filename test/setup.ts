/**
 * Test preload — makes the suite hermetic.
 *
 * Without this, tests ran against the developer's live instance: the real
 * `jig.db` (seeding and deleting jigs in it) and the real `.jig/` connection
 * artifacts, which are generated from whichever MCP servers that machine
 * happens to have connected. That made results machine-dependent — an upstream
 * MCP schema change could turn the suite red with no code change, and a clean
 * clone had no connections at all, so connection-dependent tests silently
 * no-op'd instead of running.
 *
 * Here we point DATA_DIR, META_DIR, and the CLI remote-manifest directory at a
 * scratch tree and generate connection artifacts from the frozen schemas in
 * `test/fixtures/schemas/`. The scratch tree stays under the project root so
 * tsconfig path aliases resolve the same way they do for a real jig.
 *
 * Registered via `[test] preload` in bunfig.toml, so it runs before any test
 * file imports src/config/paths.ts and freezes those paths.
 */
import { cpSync, mkdirSync, rmSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const SCRATCH_DIR = join(TEST_DIR, ".tmp")

// Must be set before src/config/paths.ts is imported anywhere.
process.env.JIG_DATA_DIR = SCRATCH_DIR
process.env.JIG_META_DIR = SCRATCH_DIR
process.env.JIG_REMOTES_DIR = join(SCRATCH_DIR, "remotes")
// Never let a test take the service-mode branch off a stray platform env var.
delete process.env.JIG_PUBLIC_URL
delete process.env.RAILWAY_ENVIRONMENT_ID
delete process.env.RAILWAY_PROJECT_ID

rmSync(SCRATCH_DIR, { recursive: true, force: true })
mkdirSync(SCRATCH_DIR, { recursive: true })
cpSync(join(TEST_DIR, "fixtures/schemas"), join(SCRATCH_DIR, "schemas"), { recursive: true })

const { generateConnectionArtifacts } = await import("../src/mcp/typegen.js")
await generateConnectionArtifacts()

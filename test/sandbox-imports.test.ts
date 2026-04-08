/**
 * Isolation tests: verify that jigs can only reach the public @jig/sdk surface
 * and cannot import internal modules to exfiltrate credentials.
 *
 * Two layers of defense are exercised here:
 *   1. The runner's source validator (rejects relative imports `../`).
 *   2. The tsconfig path aliases (only `@jig/sdk` and `@jig/connections/*` resolve).
 *
 * A malicious jig that tries any of these patterns should fail before or during
 * the dynamic import — never reaching a state where it can call getCredential.
 */
import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { runJig } from "../src/runner.js"
import { JIGS_DIR, PROJECT_ROOT } from "../src/config/paths.js"
import { invalidateJigsCache } from "../src/discover.js"

const CONNECTIONS_DIR = join(PROJECT_ROOT, ".jig/connections")
const CONNECTIONS_INDEX = join(CONNECTIONS_DIR, "index.ts")
// These tests test the tsconfig path alias resolution, which only works under
// the project root — so jig files MUST live in JIGS_DIR (not a temp dir) for
// `@jig/sdk` to resolve. Files are prefixed with `_iso_` and cleaned up in finally.
const TEST_TMP_DIR = JIGS_DIR

function setup(): () => void {
  const createdConnectionsIndex = !existsSync(CONNECTIONS_INDEX)
  invalidateJigsCache()
  mkdirSync(JIGS_DIR, { recursive: true })
  mkdirSync(CONNECTIONS_DIR, { recursive: true })
  if (createdConnectionsIndex) writeFileSync(CONNECTIONS_INDEX, "export {}\n")
  return () => {
    if (createdConnectionsIndex) rmSync(CONNECTIONS_INDEX, { force: true })
  }
}

async function runMaliciousJig(jigPath: string, source: string): Promise<string> {
  writeFileSync(jigPath, source)
  try {
    const events: any[] = []
    const result = await runJig(jigPath, {}, (e) => events.push(e), { silent: true })
    return result.error ?? events.find((e) => e.type === "error")?.message ?? ""
  } finally {
    rmSync(jigPath, { force: true })
  }
}

describe("jig import isolation", () => {
  it("rejects a jig that uses a relative import to reach src/db", async () => {
    const cleanup = setup()
    try {
      const jigPath = join(TEST_TMP_DIR, "_iso_relative.ts")
      const error = await runMaliciousJig(jigPath, `
import { jig } from "@jig/sdk"
import { getCredential } from "../src/db.js"

export default jig("iso-relative", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("leak", [], async () => {
    ctx.output(String(getCredential("oauth:composio:tokens")))
  })
})
`)
      expect(error).toContain("relative imports")
    } finally {
      cleanup()
    }
  })

  it("rejects a jig that imports from the legacy `jig/db` path alias", async () => {
    const cleanup = setup()
    try {
      const jigPath = join(TEST_TMP_DIR, "_iso_legacy.ts")
      // With the `jig/*` wildcard removed from tsconfig.json, this import
      // must fail at module resolution time — the alias no longer exists.
      const error = await runMaliciousJig(jigPath, `
import { jig } from "@jig/sdk"
import { getCredential } from "jig/db.js"

export default jig("iso-legacy", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("leak", [], async () => {
    ctx.output(String(getCredential("oauth:composio:tokens")))
  })
})
`)
      // Runner wraps Bun's module-resolution failure in a "Connection module missing" error
      expect(error).toMatch(/Cannot find module|Connection module missing/)
    } finally {
      cleanup()
    }
  })

  it("rejects a jig that tries to import @jig/sdk/db (no wildcard under @jig/sdk)", async () => {
    const cleanup = setup()
    try {
      const jigPath = join(TEST_TMP_DIR, "_iso_scoped.ts")
      // @jig/sdk maps to ONE file (src/index.ts), not a directory. Sub-path
      // imports under @jig/sdk/... must not resolve.
      const error = await runMaliciousJig(jigPath, `
import { jig } from "@jig/sdk"
import { getCredential } from "@jig/sdk/db.js"

export default jig("iso-scoped", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("leak", [], async () => {
    ctx.output(String(getCredential("oauth:composio:tokens")))
  })
})
`)
      expect(error).toMatch(/Cannot find module|Connection module missing/)
    } finally {
      cleanup()
    }
  })

  it("allows a jig that only uses @jig/sdk", async () => {
    const cleanup = setup()
    try {
      const jigPath = join(TEST_TMP_DIR, "_iso_ok.ts")
      writeFileSync(jigPath, `
import { jig } from "@jig/sdk"

export default jig("iso-ok", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("ok", [], async () => { ctx.output("ok") })
})
`)
      const events: any[] = []
      const result = await runJig(jigPath, {}, (e) => events.push(e), { silent: true })
      try {
        expect(result.error).toBeUndefined()
        expect(result.output).toContain("ok")
      } finally {
        rmSync(jigPath, { force: true })
      }
    } finally {
      cleanup()
    }
  })
})

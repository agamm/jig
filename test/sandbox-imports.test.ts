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
import { mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { runJig } from "../src/runner.js"

const TEST_TMP_DIR = mkdtempSync(join(tmpdir(), "jig-sandbox-test-"))

async function runJigSource(jigPath: string, source: string): Promise<{ error: string; output: string }> {
  writeFileSync(jigPath, source)
  try {
    const events: { type: string; message?: string }[] = []
    const result = await runJig(jigPath, {}, (e) => events.push(e), { silent: true })
    return {
      error: result.error ?? events.find((e) => e.type === "error")?.message ?? "",
      output: result.output,
    }
  } finally {
    rmSync(jigPath, { force: true })
  }
}

describe("jig import isolation", () => {
  it("rejects a jig that uses a relative import to reach src/db", async () => {
    const { error } = await runJigSource(join(TEST_TMP_DIR, "_iso_relative.ts"), `
import { jig } from "@jig/sdk"
import { getCredential } from "../src/db.js"

export default jig("iso-relative", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("leak", [], async () => {
    ctx.output(String(getCredential("oauth:composio:tokens")))
  })
})
`)
    expect(error).toContain("relative imports")
  })

  it("rejects a jig that imports from the legacy `jig/db` path alias", async () => {
    // With the `jig/*` wildcard removed from tsconfig.json, this import must
    // fail at module resolution time — the alias no longer exists.
    const { error } = await runJigSource(join(TEST_TMP_DIR, "_iso_legacy.ts"), `
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
  })

  it("rejects a jig that tries to import @jig/sdk/db (no wildcard under @jig/sdk)", async () => {
    // @jig/sdk maps to ONE file (src/index.ts), not a directory. Sub-path
    // imports under @jig/sdk/... must not resolve.
    const { error } = await runJigSource(join(TEST_TMP_DIR, "_iso_scoped.ts"), `
import { jig } from "@jig/sdk"
import { getCredential } from "@jig/sdk/db.js"

export default jig("iso-scoped", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("leak", [], async () => {
    ctx.output(String(getCredential("oauth:composio:tokens")))
  })
})
`)
    expect(error).toMatch(/Cannot find module|Connection module missing/)
  })

  it("allows a jig that only uses @jig/sdk", async () => {
    const { error, output } = await runJigSource(join(TEST_TMP_DIR, "_iso_ok.ts"), `
import { jig } from "@jig/sdk"

export default jig("iso-ok", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("ok", [], async () => { ctx.output("ok") })
})
`)
    expect(error).toBe("")
    expect(output).toContain("ok")
  })
})

import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir, homedir } from "node:os"
import { join } from "node:path"
import { resolveAuthoringTarget } from "../src/cli-agent/target.js"

/**
 * The bug this exists for: `jig new` posted to localhost unconditionally, so an
 * agent asked to make a jig on a deployed instance either authored into the
 * wrong place or went off to drive the dashboard in a browser.
 */
const remotesDir = join(homedir(), ".config", "jig", "remotes")
const LOCAL = "http://localhost:3141"
let stash: string | null = null

beforeEach(() => {
  mkdirSync(remotesDir, { recursive: true })
  stash = mkdtempSync(join(tmpdir(), "jig-remotes-stash-"))
  // Move any real manifests aside so this never depends on the dev's machine.
  for (const f of require("node:fs").readdirSync(remotesDir)) {
    require("node:fs").renameSync(join(remotesDir, f), join(stash!, f))
  }
})

afterEach(() => {
  for (const f of require("node:fs").readdirSync(remotesDir)) rmSync(join(remotesDir, f), { force: true })
  if (stash) {
    for (const f of require("node:fs").readdirSync(stash)) {
      require("node:fs").renameSync(join(stash, f), join(remotesDir, f))
    }
    rmSync(stash, { recursive: true, force: true })
    stash = null
  }
})

function writeRemote(handle: string, extra: Record<string, unknown> = {}) {
  writeFileSync(
    join(remotesDir, `${handle}.json`),
    JSON.stringify({ handle, target: "railway", public_url: `https://${handle}.example`, created_at: "2026-01-01T00:00:00Z", ...extra }),
  )
}

describe("resolveAuthoringTarget", () => {
  it("authors on the deployed instance when there is one", () => {
    writeRemote("prod", { session_cookie: "cookie-value" })
    const target = resolveAuthoringTarget([], LOCAL)
    expect(target.remote).toBe(true)
    expect(target.base).toBe("https://prod.example")
    expect(target.headers.Cookie).toBe("jig-admin=cookie-value")
  })

  it("falls back to local only when no instance is known", () => {
    const target = resolveAuthoringTarget([], LOCAL)
    expect({ remote: target.remote, base: target.base }).toEqual({ remote: false, base: LOCAL })
  })

  it("honours --local even with a deployed instance", () => {
    writeRemote("prod", { session_cookie: "cookie-value" })
    expect(resolveAuthoringTarget(["--local"], LOCAL).remote).toBe(false)
  })

  it("refuses rather than silently authoring locally when the remote is unpaired", () => {
    // Falling back here would put the jig on the wrong instance, which is the
    // kind of mistake you only notice much later.
    writeRemote("prod")
    expect(() => resolveAuthoringTarget([], LOCAL)).toThrow(/No cached session for prod/)
  })
})

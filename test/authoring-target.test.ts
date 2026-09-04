import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { rmSync, writeFileSync, mkdirSync } from "node:fs"
import { join } from "node:path"
import { resolveAuthoringTarget } from "../src/cli-agent/target.js"

/**
 * The bug this exists for: `jig new` posted to localhost unconditionally, so an
 * agent asked to make a jig on a deployed instance either authored into the
 * wrong place or went off to drive the dashboard in a browser.
 */
const remotesDir = process.env.JIG_REMOTES_DIR!
const LOCAL = "http://localhost:3141"

beforeEach(() => {
  rmSync(remotesDir, { recursive: true, force: true })
  mkdirSync(remotesDir, { recursive: true })
})

afterEach(() => {
  rmSync(remotesDir, { recursive: true, force: true })
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

  it("rejects conflicting or nonexistent explicit targets", () => {
    expect(() => resolveAuthoringTarget(["--local", "--handle=prod"], LOCAL)).toThrow(/Choose one target/)
    expect(() => resolveAuthoringTarget(["--handle="], LOCAL)).toThrow(/requires a remote name/)
    expect(() => resolveAuthoringTarget(["--handle=prod"], LOCAL)).toThrow(/No remotes configured/)
  })

  it("selects one remote with --handle when several exist", () => {
    writeRemote("staging", { session_cookie: "staging-cookie" })
    writeRemote("prod", { session_cookie: "prod-cookie" })

    const target = resolveAuthoringTarget(["--handle=prod"], LOCAL)
    expect(target.remote).toBe(true)
    expect(target.base).toBe("https://prod.example")
    expect(target.headers.Cookie).toBe("jig-admin=prod-cookie")
    if (target.remote) expect(target.manifest.handle).toBe("prod")
  })

  it("refuses rather than silently authoring locally when the remote is unpaired", () => {
    // Falling back here would put the jig on the wrong instance, which is the
    // kind of mistake you only notice much later.
    writeRemote("prod")
    expect(() => resolveAuthoringTarget([], LOCAL)).toThrow(/No cached session for prod/)
  })
})

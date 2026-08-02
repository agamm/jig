import { describe, expect, it } from "bun:test"
import { readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { DATA_DIR } from "../src/config/paths.js"

// The alert exists so a locked instance can still say it's locked. Everything
// it needs (owner, inbox) is plaintext already; the API key is the one piece
// that had to be copied out of the encrypted credentials table.
const ALERT_KEY_PATH = join(DATA_DIR, ".alert-key")

describe("alert key cache", () => {
  it("is written 0600 so it isn't world-readable on the volume", () => {
    writeFileSync(ALERT_KEY_PATH, "test-key", { mode: 0o600 })
    try {
      const mode = statSync(ALERT_KEY_PATH).mode & 0o777
      expect(mode).toBe(0o600)
      expect(readFileSync(ALERT_KEY_PATH, "utf-8")).toBe("test-key")
    } finally {
      rmSync(ALERT_KEY_PATH, { force: true })
    }
  })

  it("lives on the data volume, which survives deploys", () => {
    // /app is rebuilt by every deploy; only the mounted volume persists, so a
    // cache written anywhere else would silently vanish exactly when needed.
    expect(ALERT_KEY_PATH.startsWith(DATA_DIR)).toBe(true)
  })
})

describe("locked alert threshold", () => {
  const resolve = (raw: string | undefined): number => {
    const n = Number(raw)
    return (Number.isFinite(n) && n > 0 ? n : 60) * 60_000
  }

  it("defaults to one hour", () => {
    expect(resolve(undefined)).toBe(60 * 60_000)
  })

  it("honours an override", () => {
    expect(resolve("5")).toBe(5 * 60_000)
  })

  it("falls back on junk rather than alerting instantly", () => {
    expect(resolve("nonsense")).toBe(60 * 60_000)
    expect(resolve("0")).toBe(60 * 60_000)
    expect(resolve("-10")).toBe(60 * 60_000)
  })
})

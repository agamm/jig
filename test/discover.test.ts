import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { discoverJigs, invalidateJigsCache } from "../src/discover.js"

const TMP = join(dirname(fileURLToPath(import.meta.url)), ".tmp-jigs")

beforeEach(() => { invalidateJigsCache(); mkdirSync(TMP, { recursive: true }) })
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

function touch(...paths: string[]) {
  for (const p of paths) {
    const full = join(TMP, p)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, "// jig")
  }
}

describe("discoverJigs", () => {
  it("finds flat jigs", () => {
    touch("email-triage.ts", "meeting-prep.ts")
    const jigs = discoverJigs(TMP)
    expect(jigs.get("email-triage")).toEqual([])
    expect(jigs.get("meeting-prep")).toEqual([])
    expect(jigs.size).toBe(2)
  })

  it("skips _ prefixed files", () => {
    touch("email-triage.ts", "_helpers.ts")
    const jigs = discoverJigs(TMP)
    expect(jigs.get("email-triage")).toEqual([])
    expect(jigs.has("_helpers")).toBe(false)
    expect(jigs.size).toBe(1)
  })

  it("ignores subdirectory .ts files", () => {
    touch("email-triage.ts", "weekly-update/acme.ts")
    const jigs = discoverJigs(TMP)
    expect(jigs.get("email-triage")).toEqual([])
    expect(jigs.has("weekly-update")).toBe(false)
    expect(jigs.size).toBe(1)
  })

  it("returns empty map for empty directory", () => {
    expect(discoverJigs(TMP).size).toBe(0)
  })
})

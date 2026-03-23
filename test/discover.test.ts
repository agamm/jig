import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdirSync, writeFileSync, rmSync } from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { discoverJigs } from "../src/discover.js"

const TMP = join(dirname(fileURLToPath(import.meta.url)), ".tmp-jigs")

beforeEach(() => mkdirSync(TMP, { recursive: true }))
afterEach(() => rmSync(TMP, { recursive: true, force: true }))

function touch(...paths: string[]) {
  for (const p of paths) {
    const full = join(TMP, p)
    mkdirSync(join(full, ".."), { recursive: true })
    writeFileSync(full, "// jig")
  }
}

describe("discoverJigs", () => {
  it("finds single-instance jigs", () => {
    touch("email-triage.ts", "meeting-prep.ts")
    const jigs = discoverJigs(TMP)
    expect(jigs.get("email-triage")).toEqual([])
    expect(jigs.get("meeting-prep")).toEqual([])
    expect(jigs.size).toBe(2)
  })

  it("finds grouped jigs with entities", () => {
    touch("weekly-update/acme.ts", "weekly-update/globex.ts")
    const jigs = discoverJigs(TMP)
    expect(jigs.get("weekly-update")).toEqual(expect.arrayContaining(["acme", "globex"]))
    expect(jigs.get("weekly-update")!.length).toBe(2)
  })

  it("skips _ prefixed files", () => {
    touch("weekly-update/acme.ts", "weekly-update/_helpers.ts")
    const jigs = discoverJigs(TMP)
    expect(jigs.get("weekly-update")).toEqual(["acme"])
  })

  it("handles mixed single and grouped", () => {
    touch("email-triage.ts", "weekly-update/acme.ts", "invoice/acme.ts", "invoice/globex.ts")
    const jigs = discoverJigs(TMP)
    expect(jigs.get("email-triage")).toEqual([])
    expect(jigs.get("weekly-update")).toEqual(["acme"])
    expect(jigs.get("invoice")).toEqual(expect.arrayContaining(["acme", "globex"]))
    expect(jigs.size).toBe(3)
  })

  it("returns empty map for empty directory", () => {
    expect(discoverJigs(TMP).size).toBe(0)
  })
})

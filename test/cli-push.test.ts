/**
 * `jig new|edit <id> --file=` / `jig pending` / `jig types` for a coding agent
 * that wrote the jig itself. Exercised against the local target, which runs the
 * same handler the HTTP route does, so remote and local cannot drift.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { closeDb, openDb } from "../src/db.js"
import { pendingCommand, pullTypes, pushJigFile } from "../src/cli-agent/push.js"
import { deleteJig, getActiveCode, getPending } from "../src/services/jig-store.js"

const JIG_ID = "cli-push-case"
const DIR = join(process.env.JIG_DATA_DIR!, "cli-push")
const LOCAL = "http://127.0.0.1:1"

function file(name: string, marker: string, broken = false): string {
  mkdirSync(DIR, { recursive: true })
  const path = join(DIR, name)
  writeFileSync(path, `
import { jig } from "@jig/sdk"

export default jig("${JIG_ID}", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("s", [], async () => { ${broken ? 'const n: number = "x"; ctx.output(n)' : `ctx.output("${marker}")`} })
})
`)
  return path
}

beforeEach(() => { closeDb(); openDb(":memory:") })
afterEach(() => {
  try { deleteJig(JIG_ID) } catch {}
  closeDb()
  rmSync(DIR, { recursive: true, force: true })
})

describe("pushJigFile", () => {
  // The agent is the owner's author: a clean push goes live, as an owner's
  // email reply does. --pending is how a push is held for review.
  it("ships a clean push by default", async () => {
    expect(await pushJigFile(JIG_ID, ["--local", `--file=${file("b.ts", "two")}`], LOCAL)).toBe(0)
    expect(getActiveCode(JIG_ID)).toContain("two")
    expect(getPending(JIG_ID)).toBeNull()
  })

  it("holds a push with --pending, then approves it through jig pending", async () => {
    expect(await pushJigFile(JIG_ID, ["--local", "--pending", `--file=${file("a.ts", "one")}`], LOCAL)).toBe(0)
    expect(getPending(JIG_ID)?.code).toContain("one")
    expect(getActiveCode(JIG_ID)).toBeNull()

    expect(await pendingCommand(JIG_ID, "approve", ["--local"], LOCAL)).toBe(0)
    expect(getActiveCode(JIG_ID)).toContain("one")
  })

  it("exits 1 and leaves broken code pending, never live", async () => {
    expect(await pushJigFile(JIG_ID, ["--local", `--file=${file("c.ts", "", true)}`], LOCAL)).toBe(1)
    expect(getPending(JIG_ID)).not.toBeNull()
    expect(getActiveCode(JIG_ID)).toBeNull()
  })

  it("refuses a bad id, a missing file and a blank file without touching the store", async () => {
    expect(await pushJigFile("Not Valid", ["--local", "--file=x.ts"], LOCAL)).toBe(1)
    expect(await pushJigFile(JIG_ID, ["--local", `--file=${join(DIR, "missing.ts")}`], LOCAL)).toBe(1)
    mkdirSync(DIR, { recursive: true })
    writeFileSync(join(DIR, "blank.ts"), "\n")
    expect(await pushJigFile(JIG_ID, ["--local", `--file=${join(DIR, "blank.ts")}`], LOCAL)).toBe(1)
    expect(getPending(JIG_ID)).toBeNull()
  })
})

describe("pullTypes", () => {
  it("writes the instance's .d.ts files to --out", async () => {
    const out = join(DIR, "types-out")
    expect(await pullTypes(["--local", `--out=${out}`], LOCAL)).toBe(0)
    expect(existsSync(out)).toBe(true)
    // The fixture instance has apify and granola connected (test/fixtures/schemas).
    expect(readdirSync(out)).toEqual(expect.arrayContaining(["apify.d.ts", "granola.d.ts", "index.d.ts"]))
  })
})

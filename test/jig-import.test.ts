import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { closeDb, openDb } from "../src/db.js"
import { getActiveCode, listAllVersions, listJigs } from "../src/services/jig-store.js"
import { importLegacyJigsIfEmpty } from "../src/services/jig-import.js"

let workDir: string

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(["git", "-c", "user.email=t@t.io", "-c", "user.name=test", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  await proc.exited
}

async function gitInitAndCommit(dir: string, file: string, contents: string, msg: string): Promise<void> {
  writeFileSync(join(dir, file), contents)
  await git(["add", file], dir)
  await git(["commit", "-m", msg], dir)
}

beforeEach(async () => {
  closeDb()
  openDb(":memory:")
  workDir = mkdtempSync(join(tmpdir(), "jig-import-test-"))
})

afterEach(() => {
  closeDb()
  rmSync(workDir, { recursive: true, force: true })
})

describe("importLegacyJigsIfEmpty", () => {
  it("is a no-op when jigs table is non-empty", async () => {
    openDb(":memory:").prepare(`INSERT INTO jigs (id, name, created_at) VALUES ('existing', 'Existing', 1)`).run()
    const summary = await importLegacyJigsIfEmpty(workDir)
    expect(summary).toBeNull()
  })

  it("returns empty summary when there is no jigs directory", async () => {
    const summary = await importLegacyJigsIfEmpty(join(workDir, "nonexistent"))
    expect(summary).toEqual({ jigsImported: 0, versionsImported: 0, jigsSkipped: 0 })
  })

  it("imports a file with no git as a single version", async () => {
    writeFileSync(join(workDir, "solo.ts"), "// solo jig")

    const summary = await importLegacyJigsIfEmpty(workDir)
    expect(summary).toEqual({ jigsImported: 1, versionsImported: 1, jigsSkipped: 0 })
    expect(getActiveCode("solo")).toBe("// solo jig")
    expect(listAllVersions("solo")).toHaveLength(1)
  })

  it("imports a chain of commits and dedupes no-op commits", async () => {
    await git(["init", "-q"], workDir)
    await git(["commit", "--allow-empty", "-m", "init"], workDir)

    await gitInitAndCommit(workDir, "foo.ts", "// v1", "jig: foo — initial")
    await gitInitAndCommit(workDir, "foo.ts", "// v2", "jig: foo — change")
    // no-op commit: re-write same content
    writeFileSync(join(workDir, "foo.ts"), "// v2")
    await git(["add", "foo.ts"], workDir)
    await git(["commit", "--allow-empty", "-m", "nothing"], workDir)
    await gitInitAndCommit(workDir, "foo.ts", "// v3", "jig: foo — final")

    const summary = await importLegacyJigsIfEmpty(workDir)
    expect(summary!.jigsImported).toBe(1)
    expect(summary!.versionsImported).toBe(3)  // 3 unique, not 4
    expect(getActiveCode("foo")).toBe("// v3")
    expect(listAllVersions("foo").map((v) => v.code)).toEqual(["// v3", "// v2", "// v1"])
  })

  it("imports multiple jigs independently", async () => {
    await git(["init", "-q"], workDir)
    await git(["commit", "--allow-empty", "-m", "init"], workDir)
    await gitInitAndCommit(workDir, "alpha.ts", "// alpha v1", "alpha init")
    await gitInitAndCommit(workDir, "beta.ts", "// beta v1", "beta init")
    await gitInitAndCommit(workDir, "alpha.ts", "// alpha v2", "alpha update")

    const summary = await importLegacyJigsIfEmpty(workDir)
    expect(summary!.jigsImported).toBe(2)
    expect(summary!.versionsImported).toBe(3)
    expect(getActiveCode("alpha")).toBe("// alpha v2")
    expect(getActiveCode("beta")).toBe("// beta v1")
  })

  it("skips _-prefixed helper files", async () => {
    writeFileSync(join(workDir, "real.ts"), "// real")
    writeFileSync(join(workDir, "_helper.ts"), "// helper")

    const summary = await importLegacyJigsIfEmpty(workDir)
    expect(summary!.jigsImported).toBe(1)
    expect(listJigs().map((j) => j.id)).toEqual(["real"])
  })

  it("captures uncommitted working-tree changes as a final version", async () => {
    await git(["init", "-q"], workDir)
    await git(["commit", "--allow-empty", "-m", "init"], workDir)
    await gitInitAndCommit(workDir, "foo.ts", "// committed", "first")
    // uncommitted edit
    writeFileSync(join(workDir, "foo.ts"), "// uncommitted edits")

    const summary = await importLegacyJigsIfEmpty(workDir)
    expect(summary!.versionsImported).toBe(2)
    expect(getActiveCode("foo")).toBe("// uncommitted edits")
  })

  it("extracts the prompt from jig-meta commit body", async () => {
    await git(["init", "-q"], workDir)
    await git(["commit", "--allow-empty", "-m", "init"], workDir)
    writeFileSync(join(workDir, "x.ts"), "// x")
    await git(["add", "x.ts"], workDir)
    await git(["commit", "-m", `jig: x — created\n\njig-meta:${JSON.stringify({ prompt: "build me x" })}`], workDir)

    await importLegacyJigsIfEmpty(workDir)
    const versions = listAllVersions("x")
    expect(versions[0].prompt).toBe("build me x")
  })
})

/**
 * `jig backup` against a deployed instance: the same target rule as edit and
 * run, the paired session on every request, the archive verified before it is
 * kept, and a restore that posts the zip to the instance's own restore route.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { buildArchive, parseArchive } from "../src/backup/archive.js"
import { collectSnapshot } from "../src/backup/index.js"
import { runBackupArgs } from "../src/cli-backup/index.js"
import { closeDb, openDb } from "../src/db.js"
import { seedJig } from "./_fixtures.js"

const remotesDir = process.env.JIG_REMOTES_DIR!
const DIR = join(process.env.JIG_DATA_DIR!, "backup-cli")
const LOCAL = "http://127.0.0.1:1"
const realFetch = globalThis.fetch

type Seen = { url: string; method: string; headers: Record<string, string>; body: Uint8Array | null }
let seen: Seen[] = []
let logs: string[] = []
const realLog = console.log

function stubFetch(reply: (s: Seen) => Response): void {
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const headers = Object.fromEntries(new Headers(init?.headers).entries())
    const body = init?.body ? new Uint8Array(await new Response(init.body as BodyInit).arrayBuffer()) : null
    const s = { url: String(input), method: init?.method ?? "GET", headers, body }
    seen.push(s)
    return reply(s)
  }) as unknown as typeof fetch
}

function writeRemote(handle: string): void {
  writeFileSync(join(remotesDir, `${handle}.json`), JSON.stringify({
    handle, target: "railway", public_url: `https://${handle}.example`, created_at: "2026-01-01T00:00:00Z", session_cookie: "cookie-value",
  }))
}

/** A real archive from an in-memory instance holding one jig. */
function archiveBytes(): Uint8Array {
  seedJig("backup-cli-jig", `
import { jig } from "@jig/sdk"
export default jig("backup-cli-jig", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("s", [], async () => { ctx.output("ok") })
})
`)
  return buildArchive(collectSnapshot(), { jigVersion: "9.9.9", createdAt: "2026-09-07T00:00:00.000Z", includeCredentials: true })
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  rmSync(remotesDir, { recursive: true, force: true })
  mkdirSync(remotesDir, { recursive: true })
  mkdirSync(DIR, { recursive: true })
  seen = []
  logs = []
  console.log = (...args: unknown[]) => { logs.push(args.map(String).join(" ")) }
})

afterEach(() => {
  console.log = realLog
  globalThis.fetch = realFetch
  closeDb()
  rmSync(remotesDir, { recursive: true, force: true })
  rmSync(DIR, { recursive: true, force: true })
})

describe("jig backup on a deployed instance", () => {
  it("downloads the archive with the paired session and keeps it only after it parses", async () => {
    writeRemote("prod")
    const bytes = archiveBytes()
    stubFetch(() => new Response(bytes as unknown as BodyInit, { headers: { "Content-Type": "application/zip" } }))
    const out = join(DIR, "remote.zip")

    await runBackupArgs(["--out", out], LOCAL)

    expect(seen).toHaveLength(1)
    expect(seen[0].url).toBe("https://prod.example/api/backup?credentials=1")
    expect(seen[0].headers.cookie).toBe("jig-admin=cookie-value")
    expect(parseArchive(new Uint8Array(readFileSync(out))).snapshot.jigs.map((j) => j.id)).toEqual(["backup-cli-jig"])
    expect(logs[0]).toBe("Backing up prod (https://prod.example)...")
    expect(logs.join("\n")).toContain("1 jig(s)")
  })

  it("asks the instance to leave credentials out, and refuses a truncated download", async () => {
    writeRemote("prod")
    const bytes = archiveBytes()
    stubFetch(() => new Response(bytes.slice(0, 40) as unknown as BodyInit))
    const out = join(DIR, "cut.zip")

    await expect(runBackupArgs(["--no-credentials", "--out", out], LOCAL)).rejects.toThrow()
    expect(seen[0].url).toBe("https://prod.example/api/backup?credentials=0")
    expect(existsSync(out)).toBe(false)
  })

  it("names the fix when the session is stale or the instance is locked", async () => {
    writeRemote("prod")
    stubFetch(() => new Response("nope", { status: 401 }))
    await expect(runBackupArgs(["--out", join(DIR, "x.zip")], LOCAL)).rejects.toThrow(/jig unlock prod/)
    stubFetch(() => new Response("locked", { status: 423 }))
    await expect(runBackupArgs(["--out", join(DIR, "x.zip")], LOCAL)).rejects.toThrow(/locked/)
  })

  it("posts the zip to the instance's restore route, preview first", async () => {
    writeRemote("prod")
    const bytes = archiveBytes()
    const file = join(DIR, "in.zip")
    writeFileSync(file, bytes)
    const plan = { jigs: { added: ["backup-cli-jig"], overwritten: [] }, credentials: 0, connections: 0, schemas: 0, memory: 0, warnings: [] }
    const manifest = parseArchive(bytes).manifest
    stubFetch((s) => new Response(JSON.stringify({ manifest, plan, applied: !s.url.includes("dryRun=1") })))

    await runBackupArgs(["restore", file, "--dry-run"], LOCAL)
    expect(seen[0].method).toBe("POST")
    expect(seen[0].url).toBe("https://prod.example/api/backup/restore?dryRun=1")
    expect(seen[0].headers.cookie).toBe("jig-admin=cookie-value")
    expect(seen[0].headers["content-type"]).toBe("application/zip")
    expect(seen[0].body).toEqual(bytes)
    expect(logs.join("\n")).toContain("Nothing was changed")

    await runBackupArgs(["restore", file, "--backup-password=old-pass"], LOCAL)
    // A real restore previews first (that is what says whether a password is needed), then applies.
    expect(seen[1].url).toBe("https://prod.example/api/backup/restore?dryRun=1")
    expect(seen[2].url).toBe("https://prod.example/api/backup/restore?dryRun=0")
    // The backup's password rides in a header, never in the URL.
    expect(seen[2].headers["x-jig-backup-password"]).toBe("old-pass")
    expect(seen[1].headers["x-jig-backup-password"]).toBeUndefined()
    expect(logs.join("\n")).toContain("add 1 jig(s): backup-cli-jig")
    // The instance re-syncs its own scheduler; only a local restore needs a start.
    expect(logs.join("\n")).not.toContain("Start jig")
  })

  it("stays in-process with --local and never touches the network", async () => {
    writeRemote("prod")
    stubFetch(() => { throw new Error("network must not be used") })
    archiveBytes()
    const out = join(DIR, "local.zip")

    await runBackupArgs(["--local", "--out", out], LOCAL)

    expect(seen).toHaveLength(0)
    expect(parseArchive(new Uint8Array(readFileSync(out))).snapshot.jigs.map((j) => j.id)).toEqual(["backup-cli-jig"])
    expect(logs[0]).toBe("Backing up this machine...")
  })
})

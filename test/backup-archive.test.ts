import { describe, expect, it } from "bun:test"
import { readZip } from "../src/backup/zip.js"
import {
  BACKUP_FORMAT_VERSION,
  buildArchive,
  entryNameForJig,
  parseArchive,
  type BackupSnapshot,
} from "../src/backup/archive.js"

const str = (b: Uint8Array) => new TextDecoder().decode(b)

const snapshot = (over: Partial<BackupSnapshot> = {}): BackupSnapshot => ({
  jigs: [
    { id: "daily-digest", name: "Daily Digest", code: "export default jig('daily-digest')", createdAt: 1_700_000_000_000 },
  ],
  schedules: [{ jigId: "daily-digest", enabled: true, triggerType: "cron", cronExpr: "0 9 * * *", timezone: "America/Chicago", missedStrategy: "catch-up" }],
  credentials: [{ key: "composio:api_key", value: "v1.ENCRYPTED", server: "composio", encrypted: true }],
  crypto: { salt: "abc123", canary: "v1.CANARY" },
  customServers: { myserver: { type: "http", url: "https://example.test" } },
  toolPermissions: [{ connection: "composio", tool: "gmail_send_email", policy: "ask" }],
  schemas: { "composio.json": '[{"name":"gmail_fetch_emails"}]' },
  settings: { "models.main": "openai/gpt-5.6-luna-pro" },
  memory: [{ jigId: "daily-digest", key: "flagged:abc", value: '{"messageId":"abc"}' }],
  ...over,
})

const opts = { jigVersion: "0.1.100", createdAt: "2026-08-22T22:00:00.000Z" }

describe("buildArchive / parseArchive", () => {
  it("round-trips every section unchanged", () => {
    const original = snapshot()

    const { snapshot: back } = parseArchive(buildArchive(original, opts))

    expect(back).toEqual(original)
  })

  it("writes each jig as a readable .ts file, not only as escaped json", () => {
    const names = readZip(buildArchive(snapshot(), opts)).map((e) => e.name)

    expect(names).toContain("jigs/daily-digest.ts")
    expect(names).toContain("manifest.json")
    expect(names).toContain("schemas/composio.json")
  })

  it("records what is inside, so the file can be checked without restoring", () => {
    const { manifest } = parseArchive(buildArchive(snapshot(), opts))

    expect(manifest.formatVersion).toBe(BACKUP_FORMAT_VERSION)
    expect(manifest.jigVersion).toBe("0.1.100")
    expect(manifest.createdAt).toBe("2026-08-22T22:00:00.000Z")
    expect(manifest.counts).toEqual({ jigs: 1, credentials: 1, connections: 1, schemas: 1, memory: 1 })
    expect(manifest.includesCredentials).toBe(true)
  })

  it("can omit credentials entirely, and says so in the manifest", () => {
    const archive = buildArchive(snapshot(), { ...opts, includeCredentials: false })
    const names = readZip(archive).map((e) => e.name)
    const { manifest, snapshot: back } = parseArchive(archive)

    expect(names).not.toContain("credentials.json")
    expect(manifest.includesCredentials).toBe(false)
    expect(manifest.counts.credentials).toBe(0)
    expect(back.credentials).toEqual([])
    expect(back.crypto).toBeNull()
    // Everything else still survives the trip.
    expect(back.jigs).toEqual(snapshot().jigs)
  })

  it("keeps the secret material out of the archive when omitted", () => {
    const archive = buildArchive(snapshot(), { ...opts, includeCredentials: false })

    const allText = readZip(archive).map((e) => str(e.data)).join("\n")
    expect(allText).not.toContain("v1.ENCRYPTED")
    expect(allText).not.toContain("v1.CANARY")
  })

  it("survives a jig with no code and no schedules at all", () => {
    const empty = snapshot({ jigs: [], schedules: [], memory: [], schemas: {} })

    expect(parseArchive(buildArchive(empty, opts)).snapshot).toEqual(empty)
  })
})

describe("entryNameForJig", () => {
  // A restore reads names straight out of an archive that may not be ours.
  it("never lets a jig id escape the jigs/ directory", () => {
    // The invariant is that the result is always exactly one path segment
    // under jigs/, whatever the id contained.
    for (const hostile of ["../../etc/passwd", "a/b", "..", "C:\\win", "x\u0000y"]) {
      const name = entryNameForJig(hostile)
      expect(name.startsWith("jigs/")).toBe(true)
      expect(name.slice("jigs/".length)).not.toContain("/")
      expect(name.slice("jigs/".length)).not.toContain("\\")
    }
  })

  it("leaves an ordinary id readable", () => {
    expect(entryNameForJig("daily-email-reply-digest")).toBe("jigs/daily-email-reply-digest.ts")
  })
})

describe("parseArchive rejections", () => {
  it("refuses an archive with no manifest", () => {
    const notABackup = readZip
    void notABackup
    const zip = buildArchive(snapshot(), opts)
    // Strip the manifest by rebuilding without it.
    const stripped = readZip(zip).filter((e) => e.name !== "manifest.json")
    const { createZip } = require("../src/backup/zip.js")

    expect(() => parseArchive(createZip(stripped))).toThrow(/manifest/i)
  })

  it("refuses a format version it does not understand", () => {
    const zip = buildArchive(snapshot(), opts)
    const entries = readZip(zip).map((e) =>
      e.name === "manifest.json"
        ? { name: e.name, data: new TextEncoder().encode(JSON.stringify({ ...JSON.parse(str(e.data)), formatVersion: 99 })) }
        : e
    )
    const { createZip } = require("../src/backup/zip.js")

    expect(() => parseArchive(createZip(entries))).toThrow(/newer version of jig/i)
  })
})

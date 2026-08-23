import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import {
  closeDb,
  getSchedule,
  getSetting,
  listJigMemory,
  listToolPermissions,
  getCredential,
  getRawSetting,
  putRawSetting,
  openDb,
  setCredential,
  setJigMemory,
  setSetting,
  setToolPermission,
  upsertSchedule,
} from "../src/db.js"
import { CUSTOM_SERVERS_PATH, SCHEMAS_DIR } from "../src/config/paths.js"
import { lock } from "../src/crypto/password.js"
import { deleteJig, getActiveCode, importVersion, listJigs, setActiveVersion } from "../src/services/jig-store.js"
import { applyRestore, collectSnapshot, planRestore } from "../src/backup/index.js"
import { buildArchive, parseArchive } from "../src/backup/archive.js"

const JIG_ID = "backup-fixture-jig"
const CODE = `import { jig } from "@jig/sdk"\nexport default jig("${JIG_ID}", {}, async () => {})\n`

function wipe() {
  const db = openDb()
  deleteJig(JIG_ID)
  db.prepare(`DELETE FROM schedules WHERE jig_id = ?`).run(JIG_ID)
  db.prepare(`DELETE FROM jig_memory WHERE jig_id = ?`).run(JIG_ID)
  db.prepare(`DELETE FROM credentials WHERE server = 'fixture'`).run()
  db.prepare(`DELETE FROM tool_permissions WHERE connection = 'fixture'`).run()
  db.prepare(`DELETE FROM settings WHERE key = 'models'`).run()
  rmSync(CUSTOM_SERVERS_PATH, { force: true })
}

function seed() {
  const { versionId } = importVersion({
    jigId: JIG_ID, name: "Backup Fixture", code: CODE,
    message: "seed", prompt: null, parentId: null, createdAt: 1_700_000_000_000,
  })
  setActiveVersion(JIG_ID, versionId)
  upsertSchedule(JIG_ID, "cron", "0 9 * * *", "catch-up", null, null, "America/Chicago")
  openDb().prepare(`UPDATE schedules SET enabled = 0 WHERE jig_id = ?`).run(JIG_ID)
  openDb().prepare(
    `INSERT OR REPLACE INTO credentials (key, value, server, encrypted) VALUES (?, ?, 'fixture', 1)`
  ).run("fixture:api_key", "v1.CIPHERTEXT")
  setToolPermission("fixture", "dangerous_tool", "never")
  setSetting("models", { main: "openai/gpt-5.6-luna-pro" })
  setJigMemory(JIG_ID, "flagged:abc", '{"messageId":"abc"}')
  mkdirSync(SCHEMAS_DIR, { recursive: true })
  writeFileSync(join(SCHEMAS_DIR, "fixture.json"), '[{"name":"fixture_tool"}]')
  writeFileSync(CUSTOM_SERVERS_PATH, JSON.stringify({ fixture: { type: "http", url: "https://example.test" } }))
}

describe("backup and restore", () => {
  beforeEach(() => { openDb(); wipe(); seed() })
  afterEach(() => { wipe(); closeDb() })

  it("brings a wiped instance back to where it was", () => {
    const archive = buildArchive(collectSnapshot(), { jigVersion: "test", createdAt: "2026-01-01T00:00:00.000Z" })

    wipe()
    expect(getActiveCode(JIG_ID)).toBeNull()

    applyRestore(parseArchive(archive).snapshot)

    expect(getActiveCode(JIG_ID)).toBe(CODE)
    expect(listJigs().some((j) => j.id === JIG_ID)).toBe(true)
    // Disabled is the one schedule fact the jig's own code cannot rebuild.
    expect(getSchedule(JIG_ID)?.enabled).toBe(0)
    expect(getSetting<{ main: string }>("models")).toEqual({ main: "openai/gpt-5.6-luna-pro" })
    expect(listJigMemory(JIG_ID).map((r) => r.key)).toEqual(["flagged:abc"])
    expect(listToolPermissions().some((p) => p.connection === "fixture" && p.policy === "never")).toBe(true)
    expect(existsSync(join(SCHEMAS_DIR, "fixture.json"))).toBe(true)
    expect(existsSync(CUSTOM_SERVERS_PATH)).toBe(true)
  })

  it("carries credentials as ciphertext, never as plaintext", () => {
    const snapshot = collectSnapshot()
    const cred = snapshot.credentials.find((c) => c.key === "fixture:api_key")

    expect(cred?.value).toBe("v1.CIPHERTEXT")
    expect(cred?.encrypted).toBe(true)
  })

  it("restores the same archive twice without duplicating anything", () => {
    const archive = buildArchive(collectSnapshot(), { jigVersion: "test", createdAt: "2026-01-01T00:00:00.000Z" })
    wipe()

    applyRestore(parseArchive(archive).snapshot)
    applyRestore(parseArchive(archive).snapshot)

    expect(listJigs().filter((j) => j.id === JIG_ID)).toHaveLength(1)
    expect(getActiveCode(JIG_ID)).toBe(CODE)
    expect(listJigMemory(JIG_ID)).toHaveLength(1)
  })

  it("plans without changing anything", () => {
    const archive = buildArchive(collectSnapshot(), { jigVersion: "test", createdAt: "2026-01-01T00:00:00.000Z" })
    wipe()

    const plan = planRestore(parseArchive(archive).snapshot)

    expect(plan.jigs.added).toContain(JIG_ID)
    expect(getActiveCode(JIG_ID)).toBeNull()
  })

  it("reports a jig that already exists as an overwrite, not an addition", () => {
    const plan = planRestore(parseArchive(
      buildArchive(collectSnapshot(), { jigVersion: "test", createdAt: "2026-01-01T00:00:00.000Z" })
    ).snapshot)

    expect(plan.jigs.overwritten).toContain(JIG_ID)
    expect(plan.jigs.added).not.toContain(JIG_ID)
  })

  // Credentials are ciphertext, decryptable only with the key derived from the
  // backup's own salt. Writing them into an instance with a different password
  // would produce rows nothing can read.
  it("skips credentials when the target has a different password", () => {
    const snapshot = collectSnapshot()
    snapshot.crypto = { salt: "SALT-FROM-BACKUP", canary: "v1.CANARY" }
    putRawSetting("password.salt", "A-COMPLETELY-DIFFERENT-SALT")

    const result = applyRestore(snapshot)

    expect(result.credentialsSkipped).toBe(true)
    expect(result.warnings.join(" ")).toMatch(/password/i)
    expect(getRawSetting("password.salt")).toBe("A-COMPLETELY-DIFFERENT-SALT")

    openDb().prepare(`DELETE FROM settings WHERE key = 'password.salt'`).run()
  })

  it("restores credentials when forced, and says the password must match", () => {
    const snapshot = collectSnapshot()
    snapshot.crypto = { salt: "SALT-FROM-BACKUP", canary: "v1.CANARY" }
    putRawSetting("password.salt", "A-COMPLETELY-DIFFERENT-SALT")

    const result = applyRestore(snapshot, { force: true })

    expect(result.credentialsSkipped).toBe(false)
    expect(getRawSetting("password.salt")).toBe("SALT-FROM-BACKUP")

    openDb().prepare(`DELETE FROM settings WHERE key = 'password.salt'`).run()
  })
})

// The bug this pins: crypto/password.ts keeps private accessors that write the
// salt as a RAW string, while db.ts's getSetting JSON.parses and returns null
// when that throws. Reading the salt the wrong way produced a backup holding
// encrypted credentials and no salt, which is unrecoverable by any password.
describe("credential portability", () => {
  const CRED_KEY = "portable:api_key"
  const PASSWORD = "correct-horse-battery"

  function clearCrypto() {
    const db = openDb()
    db.prepare(`DELETE FROM credentials WHERE key = ?`).run(CRED_KEY)
    db.prepare(`DELETE FROM settings WHERE key IN ('password.salt','password.canary')`).run()
    lock()
  }

  // setPassword refuses to rotate, so each case starts from no password at all.
  beforeEach(() => { openDb(); clearCrypto() })
  afterEach(() => { clearCrypto(); closeDb() })

  it("carries the salt, so a restored credential still decrypts", async () => {
    const { setPassword, unlock, lock: relock } = await import("../src/crypto/password.js")
    setPassword(PASSWORD)
    setCredential(CRED_KEY, "super-secret-value", "portable")

    const snapshot = collectSnapshot()
    expect(snapshot.crypto?.salt).toBeTruthy()
    expect(snapshot.crypto?.canary).toBeTruthy()

    // Wipe the crypto material and the credential, as a fresh instance would be.
    const db = openDb()
    db.prepare(`DELETE FROM credentials WHERE key = ?`).run(CRED_KEY)
    db.prepare(`DELETE FROM settings WHERE key IN ('password.salt','password.canary')`).run()
    relock()

    applyRestore(snapshot)

    // The real proof: the original password still opens the restored rows.
    expect(unlock(PASSWORD)).toBe(true)
    expect(getCredential(CRED_KEY)).toBe("super-secret-value")
  })

  it("stores the salt exactly as the crypto module wrote it, not JSON-wrapped", async () => {
    const { setPassword } = await import("../src/crypto/password.js")
    setPassword(PASSWORD)

    const snapshot = collectSnapshot()

    // A JSON-encoded salt would arrive wrapped in quotes and silently break unlock.
    expect(snapshot.crypto?.salt.startsWith('"')).toBe(false)
    expect(snapshot.crypto?.salt).toBe(getRawSetting("password.salt") ?? "")
  })
})

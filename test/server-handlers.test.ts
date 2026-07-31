/**
 * The handler modules split out of server.ts.
 *
 * server.ts is now dispatch + error envelope; these are the domain handlers it
 * calls. Covered here because the split moved ~380 lines of behaviour and
 * nothing else asserts it directly.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, openDb } from "../src/db.js"
import {
  handleApprovePending,
  handleDiscardPending,
  handleGetPending,
  handleListVersionsV2,
  handleRestoreToPending,
} from "../src/server/handlers/versions.js"
import { handleGetConnection, handleGetConnections } from "../src/server/handlers/connections.js"
import { handleHealth, handleOAuthCallback } from "../src/server/handlers/auth.js"
import { getActiveCode, deleteJig, writePending } from "../src/services/jig-store.js"
import { seedJig } from "./_fixtures.js"

const JIG_ID = "handler-case"

function source(marker: string): string {
  return `
import { jig } from "@jig/sdk"

export default jig("${JIG_ID}", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("s", [], async () => { ctx.output("${marker}") })
})
`
}

async function body(res: Response): Promise<any> {
  return JSON.parse(await res.text())
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  try { deleteJig(JIG_ID) } catch {}
  closeDb()
})

describe("version handlers", () => {
  it("returns null pending for an unknown jig rather than 404ing", async () => {
    // A brand-new jig can have pending before it has any row the UI knows about.
    expect(await body(handleGetPending("nope"))).toBeNull()
  })

  it("exposes a pending version, then clears it on discard", async () => {
    seedJig(JIG_ID, source("v1"))
    writePending({ jigId: JIG_ID, code: source("v2"), author: "agent", message: "edit" })

    const pending = await body(handleGetPending(JIG_ID))
    expect(pending.code).toContain("v2")

    await body(handleDiscardPending(JIG_ID))
    expect(await body(handleGetPending(JIG_ID))).toBeNull()
    expect(getActiveCode(JIG_ID)).toContain("v1")
  })

  it("promotes pending to active on approve", async () => {
    seedJig(JIG_ID, source("v1"))
    writePending({ jigId: JIG_ID, code: source("v2"), author: "agent" })

    const result = await body(await handleApprovePending(JIG_ID))
    expect(result.ok).toBe(true)
    expect(getActiveCode(JIG_ID)).toContain("v2")
    expect(await body(handleGetPending(JIG_ID))).toBeNull()
  })

  it("refuses to approve when there is nothing pending", async () => {
    seedJig(JIG_ID, source("v1"))
    await expect(handleApprovePending(JIG_ID)).rejects.toThrow("No pending changes")
  })

  it("restores an older version as pending, not straight to active", async () => {
    seedJig(JIG_ID, source("v1"))
    const history = await body(handleListVersionsV2(JIG_ID))
    const firstVersionId = history.active.id

    writePending({ jigId: JIG_ID, code: source("v2"), author: "agent" })
    await handleApprovePending(JIG_ID)
    expect(getActiveCode(JIG_ID)).toContain("v2")

    await handleRestoreToPending(JIG_ID, { versionId: firstVersionId })
    // Restore stages the old code for review; active is untouched until approve.
    expect(getActiveCode(JIG_ID)).toContain("v2")
    expect((await body(handleGetPending(JIG_ID))).code).toContain("v1")
  })

  it("refuses to restore over an existing pending change", async () => {
    seedJig(JIG_ID, source("v1"))
    const history = await body(handleListVersionsV2(JIG_ID))
    writePending({ jigId: JIG_ID, code: source("v2"), author: "agent" })

    await expect(handleRestoreToPending(JIG_ID, { versionId: history.active.id }))
      .rejects.toThrow("A pending change already exists")
  })

  it("rejects a malformed versionId", async () => {
    seedJig(JIG_ID, source("v1"))
    await expect(handleRestoreToPending(JIG_ID, { versionId: "abc" }))
      .rejects.toThrow("Missing or invalid versionId")
  })

  it("lists an empty history for an unknown jig", async () => {
    expect(await body(handleListVersionsV2("nope"))).toEqual({ active: null, pending: null, history: [] })
  })
})

describe("connection handlers", () => {
  it("reports the fixture servers as connected with their tool counts", async () => {
    const connections = await body(await handleGetConnections())
    const byName = Object.fromEntries(connections.map((c: any) => [c.name, c]))
    expect(byName.apify.connected).toBe(true)
    expect(byName.apify.toolCount).toBeGreaterThan(0)
    // A configured-but-unconnected server is listed with no tools.
    expect(byName.notion.connected).toBe(false)
    expect(byName.notion.toolCount).toBe(0)
  })

  it("returns a connection's tools with read-only/destructive normalized", async () => {
    const detail = await body(await handleGetConnection("apify"))
    expect(detail.name).toBe("apify")
    const callActor = detail.tools.find((t: any) => t.name === "call-actor")
    expect(callActor.readOnly).toBe(false)
    const getItems = detail.tools.find((t: any) => t.name === "get-dataset-items")
    expect(getItems.readOnly).toBe(true)
  })

  it("reports which jigs use a connection", async () => {
    seedJig(JIG_ID, `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("${JIG_ID}", { trigger: { type: "manual" }, tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("s", [apify.call_actor], async () => {
    await apify.call_actor({ actor: "a/b", input: {} })
  })
})
`)
    const detail = await body(await handleGetConnection("apify"))
    expect(detail.usedBy).toContain(JIG_ID)
  })

  it("rejects an unknown connection and a malformed name", async () => {
    await expect(handleGetConnection("no-such-server")).rejects.toThrow("Connection not found")
    await expect(handleGetConnection("../etc")).rejects.toThrow("Invalid connection name")
  })
})

describe("auth handlers", () => {
  it("serves health without auth in local mode", async () => {
    const res = await handleHealth(new Request("http://localhost/api/health"), "9.9.9", Date.now() - 5000)
    const payload = await body(res)
    expect(payload.version).toBe("9.9.9")
    expect(payload.mode).toBe("local")
    expect(payload.locked).toBe(false)
    // Local mode is always "authed", so admin fields are present.
    expect(payload.uptime_s).toBeGreaterThanOrEqual(4)
    expect(payload.data_storage.ok).toBe(true)
  })

  it("renders an OAuth error page when the provider returns an error", () => {
    const res = handleOAuthCallback(new URL("http://localhost/api/oauth/callback?error=access_denied"))
    expect(res.status).toBe(400)
    expect(res.headers.get("Content-Type")).toContain("text/html")
  })

  it("renders an error page when the callback carries no code", () => {
    const res = handleOAuthCallback(new URL("http://localhost/api/oauth/callback"))
    expect(res.status).toBe(400)
  })

  it("404s a callback that matches no pending authorization", () => {
    const res = handleOAuthCallback(new URL("http://localhost/api/oauth/callback?code=abc&state=unknown"))
    expect(res.status).toBe(404)
  })
})

describe("admin handlers", () => {
  // The reset deletes the shared scratch tree (schemas, connections, types) that
  // test/setup.ts builds once for the whole run, so rebuild it afterwards or
  // later files lose their fixtures.
  afterEach(async () => {
    const { cpSync, mkdirSync } = await import("fs")
    const { dirname, join } = await import("path")
    const { fileURLToPath } = await import("url")
    const testDir = dirname(fileURLToPath(import.meta.url))
    const scratch = join(testDir, ".tmp")
    mkdirSync(scratch, { recursive: true })
    cpSync(join(testDir, "fixtures/schemas"), join(scratch, "schemas"), { recursive: true })
    const { generateConnectionArtifacts } = await import("../src/mcp/typegen.js")
    await generateConnectionArtifacts()
  })

  it("leaves the database usable after a local-state reset", async () => {
    // Regression: the reset used to read the jig list AFTER closing the DB,
    // which reopened the singleton; unlinking the file then left an orphaned
    // handle and every later query failed with SQLITE_IOERR until restart.
    const { handleResetLocalState } = await import("../src/server/handlers/admin.js")
    const { getSetting, setSetting } = await import("../src/db.js")

    seedJig(JIG_ID, source("v1"))
    const result = await body(await handleResetLocalState())
    expect(result.ok).toBe(true)
    expect(result.deletedJigs).toContain(JIG_ID)

    // The instance must still serve requests without a restart.
    setSetting("post-reset", { works: true })
    expect(getSetting<{ works: boolean }>("post-reset")).toEqual({ works: true })
  })
})

/**
 * The bug this pins: /api/jigs skipped any jig without an active version, so a
 * jig a coding agent had just pushed (pending, awaiting approval) was invisible
 * in the dashboard and in `jig debug ls`, and looked like it never existed.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { closeDb, openDb } from "../src/db.js"
import { buildJigResponse, discoverAllJigs } from "../src/services/jig-api.js"
import { approvePending, deleteJig, writePending } from "../src/services/jig-store.js"

const ID = "pending-only-case"
const CODE = `import { jig } from "@jig/sdk"

export default jig("${ID}", { trigger: { type: "manual" } }, async (ctx) => {
  await ctx.step("s", [], async () => { ctx.output("hi") })
})
`

beforeEach(() => { closeDb(); openDb(":memory:") })
afterEach(() => { try { deleteJig(ID) } catch {} closeDb() })

describe("a jig whose only version is pending", () => {
  it("is listed, marked pending, and shows the pending code until it is approved", async () => {
    writePending({ jigId: ID, code: CODE, author: "cli", message: "first push", prompt: null })

    expect([...discoverAllJigs().keys()]).toContain(ID)
    const data = await buildJigResponse(ID, 5, true)
    expect(data.status).toBe("pending")
    expect(data.code).toBe(CODE)
    expect(data.trigger).toMatch(/manual/i)

    approvePending(ID)
    expect((await buildJigResponse(ID, 5)).status).not.toBe("pending")
  })
})

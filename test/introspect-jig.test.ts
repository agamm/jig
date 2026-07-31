import { beforeEach, afterEach, describe, expect, it } from "bun:test"
import { closeDb, openDb, setToolPermission } from "../src/db.js"
import { introspectJig } from "../src/services/introspect-jig.js"
import { deleteJig as storeDeleteJig } from "../src/services/jig-store.js"
import { seedJig } from "./_fixtures.js"

describe("introspectJig", () => {
  beforeEach(() => {
    closeDb()
    openDb(":memory:")
  })

  afterEach(() => {
    try { storeDeleteJig("introspect-case") } catch {}
    closeDb()
  })

  it("returns tools and backend permissions", async () => {
    seedJig("introspect-case", `
export default {
  options: {
    trigger: { type: "manual" },
    tools: [
      { _serverName: "workspace", _toolName: "gmail_send", _readOnly: false },
      { _serverName: "workspace", _toolName: "gmail_search", _readOnly: true },
    ],
  },
}
`)

    setToolPermission("workspace", "gmail_send", "always")

    const jig = await introspectJig("introspect-case")
    expect(jig.trigger).toBe("Manual")
    expect(jig.tools).toEqual([
      { connection: "workspace", name: "gmail_send", readOnly: false },
      { connection: "workspace", name: "gmail_search", readOnly: true },
    ])
    expect(jig.permissions).toEqual([
      { connection: "workspace", tool: "gmail_send", policy: "always" },
      { connection: "workspace", tool: "gmail_search", policy: "ask" },
    ])
  })
})

import { beforeEach, afterEach, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { JIGS_DIR } from "../src/config/paths.js"
import { closeDb, openDb, setToolPermission } from "../src/db.js"
import { invalidateJigsCache } from "../src/discover.js"
import { introspectJig } from "../src/services/introspect-jig.js"

describe("introspectJig", () => {
  beforeEach(() => {
    closeDb()
    openDb(":memory:")
    mkdirSync(JIGS_DIR, { recursive: true })
    invalidateJigsCache()
  })

  afterEach(() => {
    rmSync(join(JIGS_DIR, "introspect-case.ts"), { force: true })
    closeDb()
    invalidateJigsCache()
  })

  it("returns tools and backend permissions", async () => {
    writeFileSync(join(JIGS_DIR, "introspect-case.ts"), `
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

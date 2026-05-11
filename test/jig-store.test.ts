import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { closeDb, openDb } from "../src/db.js"
import {
  approvePending,
  deleteJig,
  discardPending,
  getActiveCode,
  getActiveVersion,
  getJigRow,
  getPending,
  importVersion,
  listAllVersions,
  listHistoryVersions,
  listJigs,
  renameJig,
  restoreVersion,
  setActiveVersion,
  writePending,
} from "../src/services/jig-store.js"

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

describe("writePending — new jig", () => {
  it("creates jig row + pending version on first write", () => {
    const { versionId } = writePending({ jigId: "foo", name: "Foo", code: "// v1", author: "agent" })

    const jig = getJigRow("foo")
    expect(jig).not.toBeNull()
    expect(jig!.name).toBe("Foo")
    expect(jig!.active_version_id).toBeNull()
    expect(jig!.pending_version_id).toBe(versionId)

    const pending = getPending("foo")
    expect(pending!.code).toBe("// v1")
    expect(pending!.publishedCode).toBe("")
    expect(pending!.addedLines).toBe(1)
    expect(pending!.removedLines).toBe(0)
  })

  it("replaces pending on subsequent agent writes within a session", () => {
    const first = writePending({ jigId: "foo", code: "// v1", author: "agent" })
    const second = writePending({ jigId: "foo", code: "// v1 take two", author: "agent" })

    expect(second.versionId).not.toBe(first.versionId)
    expect(second.pendingReplaced).toBe(true)

    // No history yet (nothing approved). Pending replaces.
    expect(listAllVersions("foo")).toHaveLength(1)
    expect(getPending("foo")!.code).toBe("// v1 take two")
  })
})

describe("approvePending", () => {
  it("promotes pending to active", () => {
    const { versionId } = writePending({ jigId: "foo", code: "// v1", author: "agent" })
    const { activeVersionId } = approvePending("foo")
    expect(activeVersionId).toBe(versionId)

    const jig = getJigRow("foo")!
    expect(jig.active_version_id).toBe(versionId)
    expect(jig.pending_version_id).toBeNull()

    expect(getPending("foo")).toBeNull()
    expect(getActiveCode("foo")).toBe("// v1")
  })

  it("throws when no pending", () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    approvePending("foo")
    expect(() => approvePending("foo")).toThrow("No pending changes")
  })

  it("creates history after approval", () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    approvePending("foo")
    writePending({ jigId: "foo", code: "// v2", author: "agent" })
    approvePending("foo")

    const all = listAllVersions("foo")
    expect(all).toHaveLength(2)
    expect(all[0].code).toBe("// v2")
    expect(all[1].code).toBe("// v1")
  })
})

describe("discardPending", () => {
  it("drops pending row, leaves active untouched", () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    approvePending("foo")
    writePending({ jigId: "foo", code: "// v2 draft", author: "agent" })

    discardPending("foo")
    expect(getPending("foo")).toBeNull()
    expect(getActiveCode("foo")).toBe("// v1")
    expect(listAllVersions("foo")).toHaveLength(1)
  })

  it("deletes the jig row entirely when discarding a never-approved draft", () => {
    writePending({ jigId: "foo", code: "// scratch", author: "agent" })
    discardPending("foo")
    expect(getJigRow("foo")).toBeNull()
    expect(listAllVersions("foo")).toHaveLength(0)
  })

  it("is a no-op when nothing is pending", () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    approvePending("foo")
    discardPending("foo")
    expect(getActiveCode("foo")).toBe("// v1")
  })
})

describe("restoreVersion", () => {
  it("writes old code as a new pending row", () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    const { activeVersionId: v1 } = approvePending("foo")
    writePending({ jigId: "foo", code: "// v2", author: "agent" })
    approvePending("foo")

    const { pendingVersionId } = restoreVersion({ jigId: "foo", versionId: v1 })
    const pending = getPending("foo")!
    expect(pending.versionId).toBe(pendingVersionId)
    expect(pending.code).toBe("// v1")
    expect(pending.author).toBe("restore")
    expect(pending.publishedCode).toBe("// v2")
  })

  it("errors if a pending already exists", () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    const { activeVersionId: v1 } = approvePending("foo")
    writePending({ jigId: "foo", code: "// v2 draft", author: "agent" })

    expect(() => restoreVersion({ jigId: "foo", versionId: v1 })).toThrow(/pending change already exists/)
  })
})

describe("listHistoryVersions", () => {
  it("excludes the pending row", () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    approvePending("foo")
    writePending({ jigId: "foo", code: "// v2", author: "agent" })
    approvePending("foo")
    writePending({ jigId: "foo", code: "// pending", author: "agent" })

    const history = listHistoryVersions("foo")
    expect(history.map((v) => v.code)).toEqual(["// v2", "// v1"])
  })
})

describe("renameJig", () => {
  it("updates jig + all version FKs", () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    approvePending("foo")
    writePending({ jigId: "foo", code: "// v2", author: "agent" })

    renameJig("foo", "bar")
    expect(getJigRow("foo")).toBeNull()
    expect(getJigRow("bar")).not.toBeNull()
    expect(getActiveCode("bar")).toBe("// v1")
    expect(getPending("bar")!.code).toBe("// v2")
    expect(listAllVersions("bar")).toHaveLength(2)
  })

  it("errors if destination jig exists", () => {
    writePending({ jigId: "foo", code: "// foo", author: "agent" })
    writePending({ jigId: "bar", code: "// bar", author: "agent" })
    expect(() => renameJig("foo", "bar")).toThrow(/already exists/)
  })

  it("rewrites jig() identifier in every historical version", () => {
    writePending({ jigId: "foo", code: 'export default jig("foo", () => {})', author: "agent" })
    approvePending("foo")
    writePending({ jigId: "foo", code: 'export default jig("foo", async () => {})', author: "agent" })
    approvePending("foo")
    writePending({ jigId: "foo", code: 'export default jig("foo", () => null)', author: "agent" })

    renameJig("foo", "bar")
    for (const v of listAllVersions("bar")) {
      expect(v.code).toContain('jig("bar"')
      expect(v.code).not.toContain('jig("foo"')
    }
  })

  it("only rewrites the first jig(\"id\", ...) call site", () => {
    // Matches the existing agent-service convention: the first jig() call in
    // the source is the declaration, subsequent occurrences (nested jigs in
    // comments / strings / metaprogramming) are left as-is.
    writePending({
      jigId: "foo",
      code: 'export default jig("foo", () => "foo bar")\n// later: jig("foo") in a comment',
      author: "agent",
    })
    renameJig("foo", "bar")
    const code = getPending("bar")!.code
    expect(code).toContain('export default jig("bar"')
    expect(code).toContain('"foo bar"')         // string literal preserved
    expect(code).toContain('// later: jig("foo") in a comment')
  })
})

describe("deleteJig", () => {
  it("hard deletes jig + versions", () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    approvePending("foo")
    writePending({ jigId: "foo", code: "// v2", author: "agent" })
    approvePending("foo")

    deleteJig("foo")
    expect(getJigRow("foo")).toBeNull()
    expect(listAllVersions("foo")).toHaveLength(0)
  })
})

describe("listJigs", () => {
  it("returns all non-archived jigs with hasPending flag", () => {
    writePending({ jigId: "a", code: "// a", author: "agent" })
    approvePending("a")
    writePending({ jigId: "b", code: "// b", author: "agent" })
    approvePending("b")
    writePending({ jigId: "b", code: "// b updated", author: "agent" })

    const jigs = listJigs()
    expect(jigs.map((j) => j.id).sort()).toEqual(["a", "b"])
    const b = jigs.find((j) => j.id === "b")!
    expect(b.hasPending).toBe(true)
    const a = jigs.find((j) => j.id === "a")!
    expect(a.hasPending).toBe(false)
  })
})

describe("importVersion (migration path)", () => {
  it("imports a chain of versions and sets the active pointer", () => {
    const { versionId: v1 } = importVersion({
      jigId: "foo", name: "Foo", code: "// v1", parentId: null, createdAt: 1000,
    })
    const { versionId: v2 } = importVersion({
      jigId: "foo", name: "Foo", code: "// v2", parentId: v1, createdAt: 2000,
    })
    setActiveVersion("foo", v2)

    expect(getActiveCode("foo")).toBe("// v2")
    expect(getActiveVersion("foo")!.id).toBe(v2)
    expect(listAllVersions("foo").map((v) => v.id)).toEqual([v2, v1])
  })
})

describe("getPending diff", () => {
  it("computes line counts + a unified diff string", () => {
    writePending({ jigId: "foo", code: "a\nb\nc\n", author: "agent" })
    approvePending("foo")
    writePending({ jigId: "foo", code: "a\nB\nc\nd\n", author: "agent" })

    const pending = getPending("foo")!
    expect(pending.addedLines).toBe(2)   // "B" and "d"
    expect(pending.removedLines).toBe(1) // "b"
    expect(pending.diff).toContain("-b")
    expect(pending.diff).toContain("+B")
    expect(pending.diff).toContain("+d")
  })
})

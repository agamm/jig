import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import { closeDb, openDb } from "../src/db.js"
import { approvePending, writePending } from "../src/services/jig-store.js"
import { gcRuntimeCache, materializeActiveVersion, runtimeCacheStats } from "../src/services/jig-runtime.js"
import { RUNTIME_DIR } from "../src/config/paths.js"

let tempDir: string

beforeEach(() => {
  closeDb()
  openDb(":memory:")
  tempDir = mkdtempSync(join(tmpdir(), "jig-runtime-test-"))
  // Wipe runtime dir to isolate tests (RUNTIME_DIR is a constant pointing into PROJECT_ROOT)
  if (existsSync(RUNTIME_DIR)) rmSync(RUNTIME_DIR, { recursive: true, force: true })
})

afterEach(() => {
  closeDb()
  rmSync(tempDir, { recursive: true, force: true })
  if (existsSync(RUNTIME_DIR)) rmSync(RUNTIME_DIR, { recursive: true, force: true })
})

describe("materializeActiveVersion", () => {
  it("returns null for jigs with no active version", async () => {
    writePending({ jigId: "foo", code: "// draft only", author: "agent" })
    const result = await materializeActiveVersion("foo")
    expect(result).toBeNull()
  })

  it("writes the active code to disk and returns the path", async () => {
    writePending({ jigId: "foo", code: "// v1 active", author: "agent" })
    const { activeVersionId } = approvePending("foo")

    const result = await materializeActiveVersion("foo")
    expect(result).not.toBeNull()
    expect(result!.versionId).toBe(activeVersionId)
    expect(readFileSync(result!.path, "utf-8")).toBe("// v1 active")
  })

  it("includes versionId in the path so module cache stays correct on approve", async () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    const v1 = approvePending("foo").activeVersionId
    const first = await materializeActiveVersion("foo")

    writePending({ jigId: "foo", code: "// v2", author: "agent" })
    const v2 = approvePending("foo").activeVersionId
    const second = await materializeActiveVersion("foo")

    expect(first!.path).not.toBe(second!.path)
    expect(first!.path).toContain(`-${v1}.ts`)
    expect(second!.path).toContain(`-${v2}.ts`)
    expect(readFileSync(second!.path, "utf-8")).toBe("// v2")
  })

  it("is a no-op when the file already exists (writeIfMissing)", async () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    approvePending("foo")
    const a = await materializeActiveVersion("foo")
    const b = await materializeActiveVersion("foo")
    expect(a!.path).toBe(b!.path)
  })
})

describe("gcRuntimeCache", () => {
  it("removes stale version files, keeps the active one", async () => {
    writePending({ jigId: "foo", code: "// v1", author: "agent" })
    approvePending("foo")
    await materializeActiveVersion("foo")

    writePending({ jigId: "foo", code: "// v2", author: "agent" })
    approvePending("foo")
    await materializeActiveVersion("foo")

    expect(runtimeCacheStats().files).toBe(2)
    const result = gcRuntimeCache()
    expect(result.removed).toBe(1)
    expect(result.kept).toBe(1)
    expect(runtimeCacheStats().files).toBe(1)
  })

  it("is safe to call when the runtime dir does not exist", () => {
    if (existsSync(RUNTIME_DIR)) rmSync(RUNTIME_DIR, { recursive: true, force: true })
    expect(() => gcRuntimeCache()).not.toThrow()
  })
})

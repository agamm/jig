import { describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { getJigFilePath } from "../src/domain/jig-source.js"
import { applyRunEvent, finishTrackedRun, getActiveRunStatusForJig, startTrackedRun } from "../src/services/run-store.js"
import { getActiveRunSnapshot, getRunDetail, startJigRun } from "../src/services/run-api.js"
import { closeDb, openDb } from "../src/db.js"
import { invalidateJigsCache } from "../src/discover.js"
import { JIGS_DIR, PROJECT_ROOT } from "../src/config/paths.js"

const CONNECTIONS_DIR = join(PROJECT_ROOT, ".jig/connections")
const CONNECTIONS_INDEX = join(CONNECTIONS_DIR, "index.ts")

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe("getJigFilePath", () => {
  it("rejects path traversal IDs", () => {
    expect(getJigFilePath("../bar")).toBeNull()
  })

  it("rejects invalid IDs", () => {
    expect(getJigFilePath("foo/../bar")).toBeNull()
  })
})

describe("getRunDetail", () => {
  it("includes read-only tool metadata from tracked runs", () => {
    const runId = 987654321
    startTrackedRun(runId, "demo", true)
    applyRunEvent(runId, {
      type: "tool",
      completed: ["list_files"],
      active: ["write_file"],
      readOnly: { list_files: true, write_file: false },
    })

    expect(getRunDetail(runId).readOnly).toEqual({
      list_files: true,
      write_file: false,
    })

    finishTrackedRun(runId)
  })
})

describe("active run snapshots", () => {
  it("returns the requested jig's active run instead of another jig", () => {
    startTrackedRun(1001, "alpha", false)
    startTrackedRun(1002, "beta", false)

    expect(getActiveRunStatusForJig("beta").runId).toBe(1002)
    expect(getActiveRunSnapshot("beta").jigId).toBe("beta")

    finishTrackedRun(1001)
    finishTrackedRun(1002)
  })
})

describe("run API invariants", () => {
  it("rejects starting a second jig while any run is active", async () => {
    const jigPath = join(JIGS_DIR, "global-lock-case.ts")
    const createdConnectionsIndex = !existsSync(CONNECTIONS_INDEX)
    closeDb()
    openDb(":memory:")
    invalidateJigsCache()
    mkdirSync(JIGS_DIR, { recursive: true })
    mkdirSync(CONNECTIONS_DIR, { recursive: true })
    if (createdConnectionsIndex) writeFileSync(CONNECTIONS_INDEX, "export {}\n")
    writeFileSync(jigPath, `
import { jig } from "jig"

export default jig("global-lock-case", {
  trigger: { type: "manual" },
}, async (ctx) => {
  ctx.output("ok")
})
`)

    startTrackedRun(2001, "already-running", false)
    try {
      await expect(startJigRun("global-lock-case", {})).rejects.toThrow("A run is already in progress")
    } finally {
      finishTrackedRun(2001)
      rmSync(jigPath, { force: true })
      if (createdConnectionsIndex) rmSync(CONNECTIONS_INDEX, { force: true })
      closeDb()
      invalidateJigsCache()
    }
  })

  it("keeps skipped runs out of run detail and active status", async () => {
    const jigPath = join(JIGS_DIR, "skip-disappears-case.ts")
    const createdConnectionsIndex = !existsSync(CONNECTIONS_INDEX)
    closeDb()
    openDb(":memory:")
    invalidateJigsCache()
    mkdirSync(JIGS_DIR, { recursive: true })
    mkdirSync(CONNECTIONS_DIR, { recursive: true })
    if (createdConnectionsIndex) writeFileSync(CONNECTIONS_INDEX, "export {}\n")
    writeFileSync(jigPath, `
import { jig } from "jig"

export default jig("skip-disappears-case", {
  trigger: { type: "manual" },
}, async (ctx) => {
  ctx.skip("not now")
})
`)

    try {
      const started = await startJigRun("skip-disappears-case", {})
      await waitFor(() => getActiveRunSnapshot("skip-disappears-case").active === false)
      expect(() => getRunDetail(started.runId)).toThrow("Run not found")
    } finally {
      rmSync(jigPath, { force: true })
      if (createdConnectionsIndex) rmSync(CONNECTIONS_INDEX, { force: true })
      closeDb()
      invalidateJigsCache()
    }
  })
})

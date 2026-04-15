import { beforeEach, describe, expect, it } from "bun:test"
import { existsSync, mkdirSync, rmSync, writeFileSync } from "fs"
import { join } from "path"
import { getJigFilePath } from "../src/domain/jig-source.js"
import { applyRunEvent, clearTrackedRunsForJig, finishTrackedRun, getActiveRunStatusForJig, resetRunStoreForTests, startTrackedRun } from "../src/services/run-store.js"
import { cancelActiveRun, getActiveRunSnapshot, getRunDetail, startJigRun } from "../src/services/run-api.js"
import { closeDb, openDb } from "../src/db.js"
import { invalidateJigsCache } from "../src/discover.js"
import { JIGS_DIR, PROJECT_ROOT } from "../src/config/paths.js"

const CONNECTIONS_DIR = join(PROJECT_ROOT, ".jig/connections")
const CONNECTIONS_INDEX = join(CONNECTIONS_DIR, "index.ts")
const CANCELLED_MESSAGE = "This operation was aborted"

async function waitFor(check: () => boolean, timeoutMs = 500): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error("Timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(() => {
  // Tests in this file share the module-level run-store state — reset so
  // stale runs from earlier tests don't leak into subsequent tests.
  resetRunStoreForTests()
})

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

  it("includes the original start time for active runs", () => {
    const before = Date.now()
    startTrackedRun(1003, "gamma", true)

    const status = getActiveRunStatusForJig("gamma")
    expect(status.startedAt).toBeDefined()
    expect(status.startedAt!).toBeGreaterThanOrEqual(before)
    expect(status.startedAt!).toBeLessThanOrEqual(Date.now())

    finishTrackedRun(1003)
  })

  it("clears recent tracked results for a deleted jig", () => {
    startTrackedRun(1004, "deleted-jig", false)
    finishTrackedRun(1004)
    expect(getActiveRunStatusForJig("deleted-jig").runId).toBe(1004)

    clearTrackedRunsForJig("deleted-jig")

    expect(getActiveRunStatusForJig("deleted-jig")).toEqual({
      active: false,
      jigId: "deleted-jig",
      completedTools: [],
      activeTools: [],
      steps: [],
    })
  })

  it("treats dry-run stub failures as limited previews instead of hard failures", () => {
    startTrackedRun(1005, "dry-run-jig", true)
    applyRunEvent(1005, { type: "step-start", seq: 1, label: "Call write tool" })
    applyRunEvent(1005, {
      type: "step-done",
      seq: 1,
      status: "fail",
      output: "[dry-run] Would call apify.call-actor with {}",
      durationMs: 5,
      connections: ["apify"],
      error: "Cannot read properties of undefined",
    })
    applyRunEvent(1005, { type: "error", message: "Cannot read properties of undefined" })
    finishTrackedRun(1005)

    const status = getActiveRunStatusForJig("dry-run-jig")
    expect(status.status).toBe("success")
    expect(status.error).toBeUndefined()
    expect(status.steps[0].status).toBe("healed")
    expect(status.steps[0].output).toContain("Use Run for a real execution")
  })
})

describe("run API invariants", () => {
  it("rejects starting a second run of the same jig while it is active", async () => {
    const jigPath = join(JIGS_DIR, "per-jig-lock-case.ts")
    const createdConnectionsIndex = !existsSync(CONNECTIONS_INDEX)
    closeDb()
    openDb(":memory:")
    invalidateJigsCache()
    mkdirSync(JIGS_DIR, { recursive: true })
    mkdirSync(CONNECTIONS_DIR, { recursive: true })
    if (createdConnectionsIndex) writeFileSync(CONNECTIONS_INDEX, "export {}\n")
    writeFileSync(jigPath, `
import { jig } from "@jig/sdk"

export default jig("per-jig-lock-case", {
  trigger: { type: "manual" },
}, async (ctx) => {
  ctx.output("ok")
})
`)

    // Simulate the same jig already running — starting it again should 409
    startTrackedRun(2001, "per-jig-lock-case", false)
    try {
      await expect(startJigRun("per-jig-lock-case", {})).rejects.toThrow("A run is already in progress")
    } finally {
      finishTrackedRun(2001)
      rmSync(jigPath, { force: true })
      if (createdConnectionsIndex) rmSync(CONNECTIONS_INDEX, { force: true })
      closeDb()
      invalidateJigsCache()
    }
  })

  it("allows starting a different jig while another is active (per-jig concurrency)", async () => {
    const jigPath = join(JIGS_DIR, "other-jig-case.ts")
    const createdConnectionsIndex = !existsSync(CONNECTIONS_INDEX)
    closeDb()
    openDb(":memory:")
    invalidateJigsCache()
    mkdirSync(JIGS_DIR, { recursive: true })
    mkdirSync(CONNECTIONS_DIR, { recursive: true })
    if (createdConnectionsIndex) writeFileSync(CONNECTIONS_INDEX, "export {}\n")
    writeFileSync(jigPath, `
import { jig } from "@jig/sdk"

export default jig("other-jig-case", {
  trigger: { type: "manual" },
}, async (ctx) => {
  ctx.output("ok")
})
`)

    // A different jig is already running — should NOT block
    startTrackedRun(3001, "some-other-jig", false)
    try {
      // Should not throw "already in progress" — different jig_id
      const result = await startJigRun("other-jig-case", {})
      expect(result).toBeDefined()
      // Wait for the async run to fully finish before cleaning up files
      await waitFor(() => getActiveRunSnapshot("other-jig-case").active === false)
    } finally {
      finishTrackedRun(3001)
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
import { jig } from "@jig/sdk"

export default jig("skip-disappears-case", {
  trigger: { type: "manual" },
}, async (ctx) => {
  await ctx.step("check", [], async () => { ctx.skip("not now") })
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

  it("cancels a running tool call by propagating the run abort signal into MCP requests", async () => {
    const jigPath = join(JIGS_DIR, "cancel-tool-case.ts")
    const helperPath = join(JIGS_DIR, "_cancel_tool_helper.ts")
    const createdConnectionsIndex = !existsSync(CONNECTIONS_INDEX)
    closeDb()
    openDb(":memory:")
    invalidateJigsCache()
    mkdirSync(JIGS_DIR, { recursive: true })
    mkdirSync(CONNECTIONS_DIR, { recursive: true })
    if (createdConnectionsIndex) writeFileSync(CONNECTIONS_INDEX, "export {}\n")
    writeFileSync(helperPath, `
import { callTool } from "../src/mcp/client"
import type { JigTool } from "../src/sdk/jig"

const connection = {
  client: {
    callTool: async (_request: any, _schema?: any, options?: { signal?: AbortSignal }) => {
      await new Promise((_, reject) => {
        if (options?.signal?.aborted) {
          reject(new Error(${JSON.stringify(CANCELLED_MESSAGE)}))
          return
        }
        options?.signal?.addEventListener("abort", () => reject(new Error(${JSON.stringify(CANCELLED_MESSAGE)})), { once: true })
      })
      return { structuredContent: { ok: true } }
    },
  },
  transport: {} as any,
  serverName: "cancelstub",
  config: {} as any,
}

function tool(name: string) {
  const fn = async (params: any) => callTool(connection as any, name, params ?? {})
  fn._serverName = "cancelstub"
  fn._toolName = name
  fn._readOnly = true
  return fn as JigTool<any, any>
}

export const wait = tool("wait")
export const cancelstub = { wait }
`)
    writeFileSync(jigPath, `
import { jig } from "@jig/sdk"
import { cancelstub } from "./_cancel_tool_helper"

export default jig("cancel-tool-case", {
  trigger: { type: "manual" },
  tools: [cancelstub.wait],
}, async (ctx) => {
  await ctx.step("Wait forever", [cancelstub.wait], async () => {
    await cancelstub.wait({})
    ctx.output("unreachable")
  })
})
`)

    try {
      const started = await startJigRun("cancel-tool-case", {})
      await waitFor(() => getActiveRunSnapshot("cancel-tool-case").active === true)
      await cancelActiveRun("cancel-tool-case")
      await waitFor(() => getActiveRunSnapshot("cancel-tool-case").active === false)

      const detail = getRunDetail(started.runId)
      expect(detail.status).toBe("fail")
      expect(detail.error).toBe("Cancelled by user")
      expect(detail.output).toBe("Cancelled by user")
      expect(detail.steps[0]?.status).toBe("fail")
      expect(detail.steps[0]?.output).toContain("Cancelled by user")
    } finally {
      rmSync(jigPath, { force: true })
      rmSync(helperPath, { force: true })
      if (createdConnectionsIndex) rmSync(CONNECTIONS_INDEX, { force: true })
      closeDb()
      invalidateJigsCache()
    }
  })
})

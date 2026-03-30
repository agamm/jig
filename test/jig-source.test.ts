import { describe, expect, it } from "bun:test"
import { getJigFilePath, selectJigEntity } from "../src/domain/jig-source.js"
import { applyRunEvent, finishTrackedRun, startTrackedRun } from "../src/services/run-store.js"
import { getRunDetail } from "../src/services/run-api.js"

describe("selectJigEntity", () => {
  it("rejects invalid entity names", () => {
    expect(selectJigEntity(["foo"], "../bar")).toEqual({ ok: false, reason: "invalid" })
  })

  it("requires explicit entity for grouped jigs unless a default is allowed", () => {
    expect(selectJigEntity(["alpha", "beta"])).toEqual({
      ok: false,
      reason: "missing",
      available: ["alpha", "beta"],
    })
    expect(selectJigEntity(["alpha", "beta"], undefined, { defaultToFirstGrouped: true })).toEqual({
      ok: true,
      entity: "alpha",
    })
  })

  it("rejects entity names for non-grouped jigs", () => {
    expect(selectJigEntity([], "alpha")).toEqual({ ok: false, reason: "unexpected" })
  })
})

describe("getJigFilePath", () => {
  it("does not resolve traversal-style entity paths", () => {
    expect(getJigFilePath("foo", "../bar")).toBeNull()
  })
})

describe("getRunDetail", () => {
  it("includes read-only tool metadata from tracked runs", () => {
    const runId = 987654321
    startTrackedRun(runId, "demo", null, true)
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

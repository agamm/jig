import { describe, expect, it } from "bun:test"
import { getJigFilePath } from "../src/domain/jig-source.js"
import { applyRunEvent, finishTrackedRun, startTrackedRun } from "../src/services/run-store.js"
import { getRunDetail } from "../src/services/run-api.js"

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

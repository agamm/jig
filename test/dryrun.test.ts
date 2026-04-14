import { describe, expect, it } from "bun:test"
import { buildDryRunToolResult, shouldStubToolInDryRun } from "../src/sdk/dryrun.js"

describe("buildDryRunToolResult", () => {
  it("returns a simple dry-run marker object", () => {
    const result = buildDryRunToolResult("call-actor", { actor: "demo/tool" }, false) as Record<string, unknown>

    expect(result._dryRun).toBe(true)
    expect(result.tool).toBe("call-actor")
    expect(result.params).toEqual({ actor: "demo/tool" })
    expect(result.readOnly).toBe(false)
  })

  it("preserves params for later inspection", () => {
    const result = buildDryRunToolResult("send-message", { text: "hi" }, false) as Record<string, unknown>
    expect(result._dryRun).toBe(true)
    expect(result.tool).toBe("send-message")
    expect(result.params).toEqual({ text: "hi" })
  })
})

describe("shouldStubToolInDryRun", () => {
  it("detects explicit dry-run markers passed into later tool calls", () => {
    expect(shouldStubToolInDryRun({
      previous: { _dryRun: true, tool: "call-actor" },
    })).toBe(true)
  })

  it("detects undefined params that usually come from skipped tool outputs", () => {
    expect(shouldStubToolInDryRun({
      datasetId: undefined,
    })).toBe(true)
  })

  it("does not stub normal fully-resolved params", () => {
    expect(shouldStubToolInDryRun({
      datasetId: "real-dataset-id",
      limit: 10,
    })).toBe(false)
  })
})

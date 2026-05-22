import { describe, expect, it } from "bun:test"
import { ComposioSpillError, unwrapComposioResult } from "../src/mcp/discover/composio-unwrap.js"

function envelope(response: any, outerExtras: Record<string, unknown> = {}): any {
  return {
    data: {
      results: [{ response, tool_slug: "GMAIL_FETCH_EMAILS", index: 0 }],
      total_count: 1,
      success_count: 1,
      error_count: 0,
      ...outerExtras,
    },
    error: null,
    successful: true,
  }
}

describe("unwrapComposioResult", () => {
  it("returns response.data when present (no spill)", async () => {
    const raw = envelope({ successful: true, data: { messages: [{ id: "a" }, { id: "b" }] } })
    const result = await unwrapComposioResult(raw)
    expect(result).toEqual({ messages: [{ id: "a" }, { id: "b" }] })
  })

  it("falls back to response.data_preview when there is no spill marker", async () => {
    const raw = envelope({ successful: true, data_preview: { messages: [{ id: "a" }] } })
    const result = await unwrapComposioResult(raw)
    expect(result).toEqual({ messages: [{ id: "a" }] })
  })

  it("throws ComposioSpillError when the response spills (outer marker)", async () => {
    // This was the production failure mode: data_preview has 2 real items +
    // a "...18 more items" sentinel string, and remote_file_info points to
    // an unreachable sandbox file. Returning data_preview here is exactly
    // the silent-data-loss bug we are guarding against.
    const raw = envelope(
      {
        successful: true,
        data_preview: {
          messages: [
            { messageId: "1", subject: "real-1" },
            { messageId: "2", subject: "real-2" },
            "...18 more items",
          ],
        },
      },
      {
        remote_file_info: {
          message: "Complete response was large (22761 tokens). Full data saved to sandbox in /mnt/files/mex/late.json.",
          file_path: "/mnt/files/mex/late.json",
        },
      },
    )
    try {
      await unwrapComposioResult(raw)
      throw new Error("expected to throw")
    } catch (err: any) {
      expect(err).toBeInstanceOf(ComposioSpillError)
      expect(err.filePath).toBe("/mnt/files/mex/late.json")
      expect(err.message).toContain("22761 tokens")
      expect(err.message).toMatch(/Reduce max_results|paginate/)
    }
  })

  it("throws on spill even when the marker is inside the per-tool response", async () => {
    const raw = envelope({
      successful: true,
      data_preview: {},
      remote_file_info: { file_path: "/mnt/files/mex/inner.json" },
    })
    await expect(unwrapComposioResult(raw)).rejects.toBeInstanceOf(ComposioSpillError)
  })

  it("ignores spill markers with paths outside /mnt/files (defense against path-injection)", async () => {
    // A forged file_path can't trick us into emitting a malicious-looking
    // error message that names /etc/passwd, etc. The path doesn't match the
    // allow-list, so unwrap falls through to data_preview / response as if
    // there were no spill marker.
    const raw = envelope(
      { successful: true, data_preview: { ok: true } },
      { remote_file_info: { file_path: "/etc/passwd" } },
    )
    const result = await unwrapComposioResult(raw)
    expect(result).toEqual({ ok: true })
  })

  it("returns raw when the envelope is unrecognizable", async () => {
    const raw = { unexpected: true }
    const result = await unwrapComposioResult(raw)
    expect(result).toEqual({ unexpected: true })
  })
})

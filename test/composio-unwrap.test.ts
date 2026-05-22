import { describe, expect, it } from "bun:test"
import { ComposioSpillError, unwrapComposioResult } from "../src/mcp/discover/composio-unwrap.js"

/** Helper to assemble a multi-execute envelope shaped like Composio actually returns it. */
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
    const result = await unwrapComposioResult(raw, async () => {
      throw new Error("bash should not be called for inline responses")
    })
    expect(result).toEqual({ messages: [{ id: "a" }, { id: "b" }] })
  })

  it("falls back to response.data_preview when there is no spill marker", async () => {
    // Defensive: some inline-only responses use data_preview without spilling.
    const raw = envelope({ successful: true, data_preview: { messages: [{ id: "a" }] } })
    const result = await unwrapComposioResult(raw, async () => {
      throw new Error("bash should not be called when there is no remote_file_info")
    })
    expect(result).toEqual({ messages: [{ id: "a" }] })
  })

  it("recovers full data from the sandbox file when the response spills (outer marker)", async () => {
    // Matches the exact shape seen in production for GMAIL_FETCH_EMAILS:
    // remote_file_info lives on the outer envelope (raw.data.remote_file_info),
    // data_preview has 2 real items + a sentinel string.
    const raw = envelope(
      {
        successful: true,
        data_preview: {
          messages: [
            { messageId: "1", subject: "real-1" },
            { messageId: "2", subject: "real-2" },
            "...18 more items",
          ],
          resultSizeEstimate: 201,
        },
      },
      {
        remote_file_info: {
          message: "Complete response was large (22761 tokens). Full data saved to sandbox in /mnt/files/mex/late.json.",
          file_path: "/mnt/files/mex/late.json",
          filename: "late.json",
        },
      },
    )

    const fullPayload = {
      results: [
        {
          response: {
            successful: true,
            data: {
              messages: Array.from({ length: 20 }, (_, i) => ({
                messageId: String(i),
                subject: `real-${i}`,
              })),
              resultSizeEstimate: 201,
            },
          },
        },
      ],
    }

    let bashCalls = 0
    const result = await unwrapComposioResult(raw, async (toolName, toolArgs) => {
      bashCalls++
      expect(toolName).toBe("COMPOSIO_REMOTE_BASH_TOOL")
      expect(toolArgs.command).toBe("cat /mnt/files/mex/late.json")
      return { data: { stdout: JSON.stringify(fullPayload) } }
    })

    expect(bashCalls).toBe(1)
    expect(Array.isArray((result as any).messages)).toBe(true)
    expect((result as any).messages).toHaveLength(20)
    // None of the entries should be sentinel strings.
    for (const m of (result as any).messages) {
      expect(typeof m).toBe("object")
      expect(typeof (m as any).messageId).toBe("string")
    }
  })

  it("throws ComposioSpillError when the spill file fetch returns empty stdout", async () => {
    const raw = envelope(
      { successful: true, data_preview: { messages: [] } },
      { remote_file_info: { file_path: "/mnt/files/mex/late.json" } },
    )
    await expect(
      unwrapComposioResult(raw, async () => ({ data: { stdout: "" } })),
    ).rejects.toBeInstanceOf(ComposioSpillError)
  })

  it("throws ComposioSpillError if the spilled file itself spills (no recursion)", async () => {
    const raw = envelope(
      { successful: true, data_preview: {} },
      { remote_file_info: { file_path: "/mnt/files/mex/late.json" } },
    )
    await expect(
      unwrapComposioResult(raw, async () => ({
        data: {
          stdout: "some partial json",
          remote_file_info: { file_path: "/mnt/files/mex/late2.json" },
        },
      })),
    ).rejects.toBeInstanceOf(ComposioSpillError)
  })

  it("throws ComposioSpillError if the spilled stdout isn't valid JSON", async () => {
    const raw = envelope(
      { successful: true, data_preview: {} },
      { remote_file_info: { file_path: "/mnt/files/mex/late.json" } },
    )
    await expect(
      unwrapComposioResult(raw, async () => ({ data: { stdout: "not json {{{" } })),
    ).rejects.toBeInstanceOf(ComposioSpillError)
  })

  it("rejects spill paths outside /mnt/files (defense against path-injection in the marker)", async () => {
    const raw = envelope(
      { successful: true, data_preview: {} },
      { remote_file_info: { file_path: "/etc/passwd" } },
    )
    // Path doesn't match the allow-list → unwrap falls through and returns
    // data_preview (which is at least obviously useless, not crafted to read
    // arbitrary files via a forged file_path).
    let bashCalls = 0
    const result = await unwrapComposioResult(raw, async () => {
      bashCalls++
      return { data: { stdout: "{}" } }
    })
    expect(bashCalls).toBe(0)
    expect(result).toEqual({})
  })

  it("returns raw when the envelope is unrecognizable", async () => {
    const raw = { unexpected: true }
    const result = await unwrapComposioResult(raw, async () => {
      throw new Error("bash should not be called")
    })
    expect(result).toEqual({ unexpected: true })
  })
})

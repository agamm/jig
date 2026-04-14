import { describe, expect, it } from "bun:test"
import { callTool } from "../src/mcp/client.js"

describe("callTool result normalization", () => {
  it("prefers structuredContent over prose content blocks", async () => {
    const result = await callTool({
      client: {
        callTool: async () => ({
          content: [
            { type: "text", text: "human-readable summary" },
            { type: "text", text: "more prose" },
          ],
          structuredContent: {
            datasetId: "abc123",
            items: [],
          },
        }),
      },
      transport: {} as any,
      serverName: "test",
      config: {} as any,
    } as any, "demo-tool", {})

    expect(result).toEqual({
      datasetId: "abc123",
      items: [],
    })
  })

  it("parses single fenced JSON text blocks when structuredContent is absent", async () => {
    const result = await callTool({
      client: {
        callTool: async () => ({
          content: [
            {
              type: "text",
              text: "```json\n[{\"id\":1,\"name\":\"example\"}]\n```",
            },
          ],
        }),
      },
      transport: {} as any,
      serverName: "test",
      config: {} as any,
    } as any, "demo-tool", {})

    expect(result).toEqual([{ id: 1, name: "example" }])
  })
})

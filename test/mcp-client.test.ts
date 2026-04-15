import { describe, expect, it } from "bun:test"
import { callTool, shouldReconnectMcpConnection } from "../src/mcp/client.js"

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

describe("shouldReconnectMcpConnection", () => {
  it("matches stale MCP session errors", () => {
    const error = new Error(
      'Streamable HTTP error: Error POSTing to endpoint: {"jsonrpc":"2.0","error":{"code":-32000,"message":"Bad Request: Session ID 41dbdaf8-8a4b-46f1-a300-98cc51b52f10 not found"},"id":null}'
    )

    expect(shouldReconnectMcpConnection(error)).toBe(true)
  })

  it("matches nested transport close errors", () => {
    const error = {
      message: "Tool call failed",
      cause: { message: "Connection closed by peer" },
    }

    expect(shouldReconnectMcpConnection(error)).toBe(true)
  })

  it("does not retry normal tool failures", () => {
    expect(shouldReconnectMcpConnection(new Error("Actor input validation failed"))).toBe(false)
  })
})

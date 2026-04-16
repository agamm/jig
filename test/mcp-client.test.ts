import { describe, expect, it } from "bun:test"
import { callTool, discoverTools, shouldReconnectMcpConnection } from "../src/mcp/client.js"
import { USER_CANCELLED_MESSAGE } from "../src/run-cancel.js"

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

  it("rejects missing required tool parameters before the MCP call", async () => {
    await expect(callTool({
      client: {
        callTool: async () => {
          throw new Error("should not be called")
        },
        listTools: async () => ({
          tools: [
            {
              name: "gmail_send",
              inputSchema: {
                type: "object",
                properties: {
                  to: { type: "string" },
                  subject: { type: "string" },
                  body: { type: "string" },
                },
                required: ["to", "subject", "body"],
              },
            },
          ],
        }),
      },
      transport: {} as any,
      serverName: "test-required",
      config: {} as any,
    } as any, "gmail_send", { to: "a@example.com", body: "hello" })).rejects.toThrow(
      "Missing required parameter for test-required.gmail_send: subject"
    )
  })

  it("throws when a tool returns an error payload", async () => {
    await expect(callTool({
      client: {
        callTool: async () => ({
          content: [
            { type: "text", text: "{\"error\":\"Missing subject\"}" },
          ],
        }),
      },
      transport: {} as any,
      serverName: "test-error",
      config: {} as any,
    } as any, "demo-tool", {})).rejects.toThrow("Missing subject")
  })

  it("throws when the MCP result is flagged as an error", async () => {
    await expect(callTool({
      client: {
        callTool: async () => ({
          content: [
            { type: "text", text: "Bad request" },
          ],
          isError: true,
        }),
      },
      transport: {} as any,
      serverName: "test-is-error",
      config: {} as any,
    } as any, "demo-tool", {})).rejects.toThrow("Bad request")
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

describe("discoverTools cancellation", () => {
  it("stops pagination when the request is cancelled", async () => {
    const controller = new AbortController()
    let calls = 0

    await expect(discoverTools({
      client: {
        listTools: async (_params: { cursor?: string }, options?: { signal?: AbortSignal }) => {
          calls += 1
          expect(options?.signal).toBe(controller.signal)
          controller.abort()
          return {
            tools: [{ name: "ping", inputSchema: { type: "object", properties: {} } }],
            nextCursor: "page-2",
          }
        },
      },
      transport: {} as any,
      serverName: "test-discovery-cancel",
      config: {} as any,
    } as any, { signal: controller.signal })).rejects.toThrow(USER_CANCELLED_MESSAGE)

    expect(calls).toBe(1)
  })
})

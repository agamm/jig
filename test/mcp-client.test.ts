import { describe, expect, it } from "bun:test"
import { ANNOTATION_SCHEMA, callTool, discoverTools, invokeWithMcpReconnect, shouldReconnectMcpConnection } from "../src/mcp/client.js"
import { buildJsonSchema } from "../src/sdk/llm.js"
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
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

  it("normalizes Markdown markers in proxied Gmail HTML sends", async () => {
    let sentArgs: any
    await callTool({
      client: {
        callTool: async (request: any) => {
          sentArgs = request.arguments
          return { structuredContent: { ok: true } }
        },
        listTools: async () => ({ tools: [] }),
      },
      transport: {} as any,
      serverName: "composio",
      config: {} as any,
    } as any, "COMPOSIO_MULTI_EXECUTE_TOOL", {
      tools: [
        {
          tool_slug: "GMAIL_SEND_EMAIL",
          arguments: {
            to: "a@example.com",
            subject: "Coach",
            body: "<div>**TENSION:** Ship it\n**PATTERN:** Decide</div>",
            is_html: true,
          },
        },
      ],
      sync_response_to_workbench: false,
    })

    const gmailArgs = sentArgs.tools[0].arguments
    expect(gmailArgs.body).toContain("<strong>TENSION:</strong>")
    expect(gmailArgs.body).toContain("<strong>PATTERN:</strong>")
    expect(gmailArgs.body).not.toContain("**TENSION:**")
    expect(gmailArgs.is_html).toBe(true)
  })

  it("turns Markdown-ish Gmail bodies into HTML before send", async () => {
    let sentArgs: any
    await callTool({
      client: {
        callTool: async (request: any) => {
          sentArgs = request.arguments
          return { structuredContent: { ok: true } }
        },
        listTools: async () => ({ tools: [] }),
      },
      transport: {} as any,
      serverName: "workspace",
      config: {} as any,
    } as any, "gmail_send", {
      to: "a@example.com",
      subject: "Coach",
      body: "**TENSION:** Ship it",
      is_html: true,
    })

    expect(sentArgs.body).toBe("<p><strong>TENSION:</strong> Ship it</p>")
    expect(sentArgs.is_html).toBe(true)
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

  // McpError carries its code as a NUMBER, which every string/name-based check
  // skips. A gateway reporting a dead session or a failed upstream this way
  // used to reach the jig unretried and kill the whole run.
  it("retries a server-reported connection failure for a read-only tool", () => {
    const error = new McpError(ErrorCode.ConnectionClosed, "Upstream MCP server error")

    expect(shouldReconnectMcpConnection(error, { readOnly: true })).toBe(true)
    expect(shouldReconnectMcpConnection(new McpError(ErrorCode.RequestTimeout, "timed out"), { readOnly: true })).toBe(true)
  })

  it("leaves the same error fatal for a write tool", () => {
    const error = new McpError(ErrorCode.ConnectionClosed, "Upstream MCP server error")

    // The code says the reply went missing, not that the send didn't happen.
    expect(shouldReconnectMcpConnection(error, { readOnly: false })).toBe(false)
    expect(shouldReconnectMcpConnection(error)).toBe(false)
  })

  it("does not retry deterministic protocol errors even when read-only", () => {
    // Bad arguments fail identically every time, so retrying only hides them.
    expect(shouldReconnectMcpConnection(new McpError(ErrorCode.InvalidParams, "bad enum"), { readOnly: true })).toBe(false)
    expect(shouldReconnectMcpConnection(new McpError(ErrorCode.MethodNotFound, "nope"), { readOnly: true })).toBe(false)
    // -32042 sits inside the JSON-RPC server-error band but means the user has
    // to authorize in a browser; a retry would bury that prompt.
    expect(shouldReconnectMcpConnection(new McpError(-32042, "authorize first"), { readOnly: true })).toBe(false)
  })
})

describe("invokeWithMcpReconnect", () => {
  const upstreamDown = () => new McpError(ErrorCode.ConnectionClosed, "Upstream MCP server error")

  it("reconnects and succeeds on the second attempt for a read-only tool", async () => {
    let attempts = 0
    let closed = 0

    const result = await invokeWithMcpReconnect(
      "composio",
      async () => { closed++ },
      async () => {
        attempts++
        if (attempts === 1) throw upstreamDown()
        return "messages"
      },
      { readOnly: true },
    )

    expect(result).toBe("messages")
    expect(attempts).toBe(2)
    expect(closed).toBe(1)
  })

  it("throws immediately for a write tool instead of sending twice", async () => {
    let attempts = 0

    await expect(invokeWithMcpReconnect(
      "composio",
      async () => {},
      async () => { attempts++; throw upstreamDown() },
      { readOnly: false },
    )).rejects.toThrow("Upstream MCP server error")

    expect(attempts).toBe(1)
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

describe("ensureAnnotations schema", () => {
  // This call passed the bare "array", which buildJsonSchema rejects. It threw
  // before reaching the model on every connect, and the catch classified every
  // tool on every server as not-read-only, silently disabling read-only-gated
  // retries, stubbing every tool in dry-run, and blocking introspection.
  it("is a schema the SDK can actually build", () => {
    expect(buildJsonSchema(ANNOTATION_SCHEMA)).toEqual({
      type: "object",
      properties: {
        readOnly: { type: "array", items: { type: "string" } },
        destructive: { type: "array", items: { type: "string" } },
      },
      required: ["readOnly", "destructive"],
      additionalProperties: false,
    })
  })
})

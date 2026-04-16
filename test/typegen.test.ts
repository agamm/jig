/**
 * Tests for typegen — pure string templating that generates runtime connection
 * modules from MCP tool schemas. These are critical because a broken template
 * produces broken TypeScript that fails at compile time for every jig.
 */
import { describe, it, expect } from "bun:test"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import {
  generateRuntimeModule,
  generateProxyRuntimeModule,
  generateTypeDeclaration,
  toolNameToIdentifier,
} from "../src/mcp/typegen.js"

const sampleTools: Tool[] = [
  {
    name: "telegram_send_message",
    description: "Send a text message to a Telegram chat",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string", description: "Target chat ID" },
        text: { type: "string", description: "Message body" },
      },
      required: ["chat_id", "text"],
    },
    annotations: { readOnlyHint: false },
  },
  {
    name: "telegram_get_chat",
    description: "Fetch info about a chat",
    inputSchema: {
      type: "object",
      properties: {
        chat_id: { type: "string" },
      },
      required: ["chat_id"],
    },
    annotations: { readOnlyHint: true },
  },
]

const hyphenatedTools: Tool[] = [
  {
    name: "search-actors",
    description: "Search actors",
    inputSchema: {
      type: "object",
      properties: {
        "max-results": { type: "integer", description: "Maximum result count" },
      },
      required: [],
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: "apify--rag-web-browser",
    description: "Fetch web data",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
      },
      required: ["query"],
    },
    annotations: { readOnlyHint: false },
  },
]

describe("generateRuntimeModule (direct)", () => {
  it("generates tool exports with correct readOnly flags from annotations", () => {
    const code = generateRuntimeModule("testsvc", sampleTools)
    expect(code).toContain(`export const telegram_send_message = tool<telegram_send_message_params, any>("telegram_send_message", false)`)
    expect(code).toContain(`export const telegram_get_chat = tool<telegram_get_chat_params, any>("telegram_get_chat", true)`)
  })

  it("embeds exact generated param types into the runtime exports", () => {
    const code = generateRuntimeModule("testsvc", sampleTools)
    expect(code).toContain("type telegram_send_message_params = {")
    expect(code).toContain("chat_id: string")
    expect(code).toContain('export const telegram_send_message = tool<telegram_send_message_params, any>("telegram_send_message", false)')
    expect(code).not.toContain("JigTool<any, any>")
  })

  it("generates a barrel export with all tool names", () => {
    const code = generateRuntimeModule("testsvc", sampleTools)
    expect(code).toContain(`export const testsvc = { telegram_send_message, telegram_get_chat }`)
  })

  it("generates direct callTool invocation (not proxied)", () => {
    const code = generateRuntimeModule("testsvc", sampleTools)
    // Direct modules call the MCP tool by name — not through a meta-tool
    expect(code).toContain(`await callTool(await conn(), name, (params ?? {}) as Record<string, unknown>)`)
    expect(code).toContain(`shouldReconnectMcpConnection`)
    // Must NOT contain any proxy-specific wrapping
    expect(code).not.toContain("tool_slug:")
    expect(code).not.toContain("COMPOSIO_MULTI_EXECUTE_TOOL")
  })

  it("embeds the server name in connection bootstrap", () => {
    const code = generateRuntimeModule("my-server", sampleTools)
    expect(code).toContain(`getServerConfig("my-server")`)
    expect(code).toContain(`connectServer("my-server"`)
    expect(code).toContain(`registerConnection("my-server"`)
  })

  it("sanitizes invalid tool names into valid export identifiers", () => {
    const code = generateRuntimeModule("apify", hyphenatedTools)
    expect(code).toContain(`export const search_actors = tool<search_actors_params, any>("search-actors", true)`)
    expect(code).toContain(`export const apify_rag_web_browser = tool<apify_rag_web_browser_params, any>("apify--rag-web-browser", false)`)
    expect(code).toContain(`"search-actors": search_actors`)
    expect(code).toContain(`"apify--rag-web-browser": apify_rag_web_browser`)
  })

  it("emits dry-run output instead of synthesizing schema-shaped results", () => {
    const code = generateRuntimeModule("testsvc", sampleTools)
    expect(code).toContain(`ctx?.output(\`[dry-run] Would call testsvc.\${name} with \${JSON.stringify(params ?? {})}\`)`)
    expect(code).toContain("buildDryRunToolResult")
    expect(code).toContain("shouldStubToolInDryRun")
    expect(code).not.toContain("DRY_RUN_OUTPUT_SCHEMAS")
  })
})

describe("generateProxyRuntimeModule", () => {
  const proxyCallCode = `
    const slug = name.toUpperCase()
    const raw: any = await callTool(await conn(), "META_EXECUTE", {
      tools: [{ tool_slug: slug, arguments: params ?? {} }],
    })
    return raw?.data?.results?.[0]?.response?.data ?? raw`

  it("inlines the proxy call code in the tool factory body", () => {
    const code = generateProxyRuntimeModule("testproxy", sampleTools, proxyCallCode)
    expect(code).toContain("META_EXECUTE")
    expect(code).toContain("tool_slug: slug")
    expect(code).toContain("name.toUpperCase()")
    expect(code).toContain("invokeWithReconnect")
  })

  it("does NOT fall back to direct callTool invocation", () => {
    // Proxy modules must route through the meta-tool, not call MCP tool by name
    const code = generateProxyRuntimeModule("testproxy", sampleTools, proxyCallCode)
    expect(code).not.toContain("return callTool(await conn(), name, params ?? {})")
  })

  it("preserves tool names and readOnly annotations in exports", () => {
    const code = generateProxyRuntimeModule("testproxy", sampleTools, proxyCallCode)
    expect(code).toContain(`export const telegram_send_message = tool<telegram_send_message_params, any>("telegram_send_message", false)`)
    expect(code).toContain(`export const telegram_get_chat = tool<telegram_get_chat_params, any>("telegram_get_chat", true)`)
  })

  it("generates the same barrel export shape as direct modules", () => {
    const code = generateProxyRuntimeModule("testproxy", sampleTools, proxyCallCode)
    expect(code).toContain(`export const testproxy = { telegram_send_message, telegram_get_chat }`)
  })

  it("marks the generated file as a proxy module in its header", () => {
    const code = generateProxyRuntimeModule("testproxy", sampleTools, proxyCallCode)
    expect(code).toContain("proxy module")
  })

  it("keeps step-allowlist enforcement (proxy tools still respect ctx.step)", () => {
    const code = generateProxyRuntimeModule("testproxy", sampleTools, proxyCallCode)
    expect(code).toContain("isToolAllowedInCurrentStep")
    expect(code).toContain("not allowed in step")
  })

  it("keeps dry-run gating for non-readOnly tools", () => {
    const code = generateProxyRuntimeModule("testproxy", sampleTools, proxyCallCode)
    expect(code).toContain("isDryRun()")
    expect(code).toContain("buildDryRunToolResult")
    expect(code).toContain("shouldStubToolInDryRun")
  })

  it("emits dry-run output for proxy tools instead of embedding schemas", () => {
    const code = generateProxyRuntimeModule("testproxy", sampleTools, proxyCallCode)
    expect(code).toContain(`ctx?.output(\`[dry-run] Would call testproxy.\${name} with \${JSON.stringify(params ?? {})}\`)`)
    expect(code).not.toContain("DRY_RUN_OUTPUT_SCHEMAS")
  })

  it("sets all _serverName, _toolName, _readOnly metadata", () => {
    const code = generateProxyRuntimeModule("testproxy", sampleTools, proxyCallCode)
    expect(code).toContain(`fn._serverName = "testproxy"`)
    expect(code).toContain("fn._toolName = name")
    expect(code).toContain("fn._readOnly = readOnly")
  })
})

describe("generateTypeDeclaration", () => {
  it("matches the runtime module export surface", () => {
    const types = generateTypeDeclaration("testsvc", sampleTools)
    expect(types).toContain("export declare function closeConnection(): Promise<void>")
    expect(types).toContain("export declare const telegram_send_message: JigTool")
    expect(types).toContain("export declare const telegram_get_chat: JigTool")
    expect(types).toContain("export declare const testsvc: {")
    expect(types).toContain("telegram_send_message: typeof telegram_send_message")
    expect(types).toContain("telegram_get_chat: typeof telegram_get_chat")
  })

  it("generates typed JigTool declarations for each tool", () => {
    const types = generateTypeDeclaration("testsvc", sampleTools)
    expect(types).toContain("telegram_send_message: JigTool")
    expect(types).toContain("telegram_get_chat: JigTool")
    expect(types).toContain("chat_id: string")
    expect(types).toContain("text: string")
  })

  it("marks required fields without optional suffix", () => {
    const types = generateTypeDeclaration("testsvc", sampleTools)
    // chat_id and text are required — no `?` after name
    expect(types).toMatch(/chat_id: string/)
    expect(types).not.toMatch(/chat_id\?: string/)
  })

  it("sanitizes */ in tool descriptions to prevent breaking JSDoc", () => {
    // This was a real bug: Composio Slack tool description contained "C*/G*"
    // which terminated the JSDoc comment mid-stream and broke TypeScript parsing
    const toolWithStarSlash: Tool = {
      name: "broken_tool",
      description: "Returns channel IDs (C*/G* prefixed) required for Slack",
      inputSchema: { type: "object", properties: {} },
    }
    const types = generateTypeDeclaration("slack", [toolWithStarSlash])
    // The */ sequence must be broken up so the JSDoc comment stays valid
    expect(types).not.toMatch(/\/\*\*[^*]*\*\/.*C\*\/G\*/)
    expect(types).toContain("C* /G*")
  })

  it("sanitizes */ in parameter descriptions too", () => {
    const tool: Tool = {
      name: "x",
      description: "ok",
      inputSchema: {
        type: "object",
        properties: {
          bad: { type: "string", description: "uses */ pattern" },
        },
      },
    }
    const types = generateTypeDeclaration("x", [tool])
    expect(types).toContain("* /")
    expect(types).not.toContain("*/ pattern")
  })

  it("sanitizes hyphenated tool and param names into valid TypeScript", () => {
    const types = generateTypeDeclaration("apify", hyphenatedTools)
    expect(types).toContain("search_actors: JigTool")
    expect(types).toContain("apify_rag_web_browser: JigTool")
    expect(types).toContain(`"max-results"?: number`)
    expect(types).not.toContain("search-actors: JigTool")
  })
})

describe("toolNameToIdentifier", () => {
  it("maps MCP tool names to safe identifiers", () => {
    expect(toolNameToIdentifier("search-actors")).toBe("search_actors")
    expect(toolNameToIdentifier("apify--rag-web-browser")).toBe("apify_rag_web_browser")
    expect(toolNameToIdentifier("1password")).toBe("_1password")
  })
})

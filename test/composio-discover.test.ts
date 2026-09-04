import { describe, expect, it } from "bun:test"
import { McpError } from "@modelcontextprotocol/sdk/types.js"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { connectedAppsHint, discover } from "../src/mcp/discover/composio.js"

const TRAILER = "No exact fit? Any HTTP or SSE endpoint can be connected as a custom MCP. Add one here: https://dashboard.composio.dev/"

/** Composio's real shape: the JSON envelope as one text part, the promo hint as a second. */
function twoPart(payload: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(payload) }, { type: "text", text: TRAILER }] }
}

const META_TOOLS: Tool[] = [
  {
    name: "COMPOSIO_SEARCH_TOOLS",
    description: "Tool Server Info: Composio connects 500+ apps. User has manually connected the apps: gmail, googlesheets. Prefer these apps when intent is unclear.",
    inputSchema: { type: "object" },
  },
]

type Call = { name: string; args: any }

function fakeConnection(handler: (call: Call) => unknown, calls: Call[] = []) {
  return {
    calls,
    connection: {
      client: { callTool: async ({ name, arguments: args }: any) => { calls.push({ name, args }); return handler({ name, args }) } },
      transport: {} as any,
      serverName: "composio-discover-test",
      config: {} as any,
    } as any,
  }
}

function searchResponse(queries: string[]) {
  const actions = queries.some((q) => q.endsWith(" actions"))
  return twoPart({
    data: {
      results: queries.map((q, index) => ({
        index,
        use_case: q,
        primary_tool_slugs: actions
          ? ["GMAIL_FETCH_EMAILS", "GOOGLESHEETS_BATCH_GET"]
          : ["GMAIL_SEND_EMAIL", "SLACK_SEND_MESSAGE", "COMPOSIO_SEARCH_TOOLS"],
        related_tool_slugs: actions ? ["GMAIL_CREATE_EMAIL_DRAFT"] : [],
      })),
      toolkit_connection_statuses: actions
        ? []
        : [
            { toolkit: "gmail", has_active_connection: true },
            { toolkit: "slack", has_active_connection: false },
          ],
      tool_schemas: {
        GMAIL_SEND_EMAIL: { description: "Send an email.\nMore detail.", input_schema: { type: "object", properties: { to: { type: "string" } } } },
        GMAIL_CREATE_EMAIL_DRAFT: { description: "Create a draft.", input_schema: { type: "object" } },
      },
    },
    successful: true,
  })
}

function manageResponse(toolkits: { name: string; action?: string }[]) {
  const results: Record<string, unknown> = {}
  for (const tk of toolkits) {
    results[tk.name] = tk.name === "gmail"
      ? { toolkit: "gmail", status: "active", accounts: [{ id: "gmail_x", status: "active" }] }
      : { toolkit: tk.name, status: "initiated", accounts: [] }
  }
  return { content: [{ type: "text", text: JSON.stringify({ data: { results }, successful: true }) }] }
}

const schemasResponse = {
  content: [{ type: "text", text: JSON.stringify({ data: { tool_schemas: {
    GMAIL_FETCH_EMAILS: { description: "Fetch emails.", input_schema: { type: "object" } },
    GOOGLESHEETS_BATCH_GET: { description: "Read ranges.", input_schema: { type: "object" } },
  } } }) }],
}

function standardHandler(call: Call): unknown {
  switch (call.name) {
    case "COMPOSIO_SEARCH_TOOLS": return searchResponse(call.args.queries.map((q: any) => q.use_case))
    case "COMPOSIO_MANAGE_CONNECTIONS": return manageResponse(call.args.toolkits)
    case "COMPOSIO_GET_TOOL_SCHEMAS": return schemasResponse
    default: throw new Error(`unexpected tool ${call.name}`)
  }
}

describe("connectedAppsHint", () => {
  it("parses the connected-apps line out of the SEARCH_TOOLS description", () => {
    expect([...connectedAppsHint(META_TOOLS)]).toEqual(["gmail", "googlesheets"])
  })
  it("is empty when the line is absent", () => {
    expect(connectedAppsHint([{ name: "COMPOSIO_SEARCH_TOOLS", description: "no hint here", inputSchema: { type: "object" } }]).size).toBe(0)
    expect(connectedAppsHint([]).size).toBe(0)
  })
})

describe("composio discover", () => {
  it("reads two-part search results, seeds from the hint, and keeps only account-confirmed toolkits", async () => {
    const { connection, calls } = fakeConnection(standardHandler)
    const tools = await discover(connection, { metaTools: META_TOOLS, retryDelaysMs: [] })

    const names = tools.map((t) => t.name).sort()
    // gmail: inline schema (send, draft) + fetched schema (fetch). slack was
    // reported inactive; googlesheets was seeded but the account list says
    // it has no active account, so its slugs are dropped.
    expect(names).toEqual(["gmail_create_email_draft", "gmail_fetch_emails", "gmail_send_email"])
    expect(tools.find((t) => t.name === "gmail_send_email")?.description).toBe("Send an email.")

    const manage = calls.filter((c) => c.name === "COMPOSIO_MANAGE_CONNECTIONS")
    expect(manage).toHaveLength(1)
    expect(manage[0].args.toolkits).toEqual([
      { name: "gmail", action: "list" },
      { name: "googlesheets", action: "list" },
    ])

    // Enumeration runs both search strategies for the connected toolkit.
    const actionSearches = calls.filter((c) => c.name === "COMPOSIO_SEARCH_TOOLS" && c.args.queries[0].use_case === "gmail actions")
    expect(actionSearches.map((c) => c.args.search_strategy)).toEqual([undefined, "tool_search"])
  })

  it("falls back to the search-reported set when the account list call fails", async () => {
    const { connection } = fakeConnection((call) => {
      if (call.name === "COMPOSIO_MANAGE_CONNECTIONS") throw new Error("boom")
      return standardHandler(call)
    })
    const tools = await discover(connection, { metaTools: META_TOOLS, retryDelaysMs: [] })
    const toolkits = new Set(tools.map((t) => t.name.split("_")[0]))
    expect(toolkits).toEqual(new Set(["gmail", "googlesheets"]))
  })

  it("throws instead of returning 0 tools when a search response has no results array", async () => {
    const { connection } = fakeConnection(() => twoPart({ data: { message: "reshaped" }, successful: true }))
    await expect(discover(connection, { retryDelaysMs: [] })).rejects.toThrow(/no results array/)
  })

  it("throws when no search response carries toolkit_connection_statuses", async () => {
    const { connection } = fakeConnection(() => twoPart({ data: { results: [{ index: 0, primary_tool_slugs: [] }] }, successful: true }))
    await expect(discover(connection, { retryDelaysMs: [] })).rejects.toThrow(/no toolkit_connection_statuses/)
  })

  it("returns an empty list, without throwing, when statuses exist and none is active", async () => {
    const { connection } = fakeConnection(() => twoPart({
      data: { results: [{ index: 0, primary_tool_slugs: [] }], toolkit_connection_statuses: [{ toolkit: "slack", has_active_connection: false }] },
      successful: true,
    }))
    expect(await discover(connection, { retryDelaysMs: [] })).toEqual([])
  })

  it("retries a transient upstream error and then succeeds", async () => {
    let failed = false
    const { connection } = fakeConnection((call) => {
      if (call.name === "COMPOSIO_SEARCH_TOOLS" && !failed) {
        failed = true
        throw new McpError(-32000 as any, "Upstream MCP server error")
      }
      return standardHandler(call)
    })
    const tools = await discover(connection, { metaTools: META_TOOLS, retryDelaysMs: [1] })
    expect(tools.length).toBeGreaterThan(0)
  })
})

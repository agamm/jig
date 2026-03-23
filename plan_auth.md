# Jig Integration Strategy

## Decision

Jig is an MCP client. Integrations are MCP servers. One protocol, one dependency (`@modelcontextprotocol/sdk`). Browser OAuth for auth. Codegen for types.

---

## User Experience

### Connect a service

```
$ jig connect gmail
  → opens browser → sign into Google → done
  → 56 Google Workspace tools available

$ jig connect granola
  → opens browser → sign into Granola → done
  → 4 Granola tools available

$ jig connect https://mcp.notion.com/mcp
  → opens browser → sign into Notion → done
  → N tools available
```

No API keys. No GCP projects. No config files. Just `jig connect <name or URL>`.

If running on a remote server, Jig auto-detects no display and opens a tunnel for the callback. User gets a URL to open on any device.

### See what's connected

```
$ jig connections
  gmail       ✓ connected   (11 tools)
  calendar    ✓ connected   (8 tools)
  granola     ✓ connected   (4 tools)
  notion      ✗ not connected
```

### Use in workflows

After connecting, the AI knows what tools exist and generates correct code:

```typescript
import { workspace, granola } from "jig/connections"

export default jig("weekly-update", {
  tools: [granola.list_meetings, workspace.gmail_search],
}, async (ctx) => {
  const meetings = await granola.list_meetings({ from: "2026-03-15" })
  const emails = await workspace.gmail_search({ query: "is:unread" })
})
```

Types are auto-generated from MCP tool discovery. JSDoc descriptions from MCP metadata help the AI pick the right tool.

---

## Why Browser OAuth

- **Zero config** — user clicks "Connect", signs in, done
- **No API keys** — no copying secrets, no `.env` files
- **No developer setup** — user never creates OAuth credentials
- **Familiar** — every user has signed into an app via Google/GitHub before
- **Trustworthy** — user sees the real Google/Slack consent screen

---

## Verified (March 22, 2026)

| Server | Tools | Real data |
|---|---|---|
| Google Workspace (`gemini-cli-extensions/workspace`, Apache 2.0) | 56 (Gmail, Calendar, Drive, Docs, Sheets, Chat) | Gmail search returned real emails |
| Granola (`mcp.granola.ai/mcp`) | 4 | 29 meetings returned |

---

## Predefined Servers

Jig ships with a registry of known MCP servers. `jig connect gmail` looks up "gmail" → workspace server. Users never think about server URLs for common services.

| User types | Server | Source |
|---|---|---|
| `gmail`, `calendar`, `drive`, `docs`, `sheets`, `chat` | gemini-workspace (local stdio) | Apache 2.0 |
| `granola` | `mcp.granola.ai/mcp` | Hosted |
| `slack` | `mcp.slack.com/mcp` | Hosted |
| `notion` | `mcp.notion.com/mcp` | Hosted |
| `linear` | `mcp.linear.app/sse` | Hosted |
| `figma` | `mcp.figma.com/mcp` | Hosted |
| `stripe` | `mcp.stripe.com` | Hosted |
| Any URL | User-provided | Custom |

---

## How It Works Internally

### Connect

1. `jig connect gmail` → resolves to workspace server config
2. Starts MCP client, connects to server
3. Server returns 401 → Jig opens browser for OAuth
4. User completes auth → callback to localhost → tokens saved to `~/.jig/tokens/`
5. `listTools()` → discovers available tools + schemas
6. Saves schemas to `.jig/schemas/`, generates `.jig/types/*.d.ts`

### Codegen

After connect, Jig generates TypeScript types from MCP tool metadata:

```typescript
// .jig/types/granola.d.ts (auto-generated)
export declare const granola: {
  /** List meeting notes within a time range */
  list_meetings: JigTool<{ from?: string; to?: string }, MeetingList>
  /** Get detailed meeting info by ID */
  get_meetings: JigTool<{ ids: string[] }, MeetingDetail[]>
  /** Get full transcript for a meeting */
  get_meeting_transcript: JigTool<{ id: string }, Transcript>
  /** Query meetings using natural language */
  query_granola_meetings: JigTool<{ query: string }, QueryResult>
}
```

The AI reads these types (with JSDoc descriptions from MCP metadata) to generate workflow code with correct tool calls.

### Permission enforcement

The `tools` array in a jig definition is the permission boundary. Jig checks it before any MCP call reaches the server:

```typescript
tools: [workspace.gmail_search, workspace.gmail_createDraft]
// gmail_search → ✓ allowed
// gmail_send   → ✗ blocked before MCP call
```

### Schema refresh

On `jig start`, Jig reconnects all servers, diffs `listTools()` against cached schemas, and regenerates types if anything changed. Also listens for MCP `tools/listChanged` notifications during runtime.

---

## v0 Scope

Ship the integration layer only:

- `jig connect <name or URL>` — auth + discover + codegen
- `jig connections` — list status
- Execute MCP tools via generated typed objects
- `tools[]` permission enforcement
- Token persistence

Not in v0: jig runtime, LLM calls, durability, dashboard, cron, assistant.

---

## File Layout

```
.jig/
  schemas/        # cached listTools() responses
  types/          # generated .d.ts files (AI reads these)
~/.jig/
  tokens/         # OAuth tokens (persisted across projects)
```

---

## Key Repos

| Repo | What | License |
|---|---|---|
| `gemini-cli-extensions/workspace` | Google Workspace MCP (56 tools) | Apache 2.0 |
| `@modelcontextprotocol/sdk` | MCP client SDK | MIT |

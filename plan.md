# Jig — Design Spec

**An AI assistant that shows you exactly what it'll do before it does it. When you like what it does, save it as an automation.**

## Problem

AI agents today (OpenClaw, etc.) rely on LLMs to route workflows, enforce permissions via prompts (soul.md), store credentials in plaintext, and waste tokens on tasks code could handle deterministically. Users get burned: deleted files, runaway actions, no audit trail, constant maintenance.

## Solution

Everything is a **jig** — a compiled, deterministic unit of work. The AI proposes what to do. You approve the scope. It executes deterministically. Code handles routing and execution. LLM handles content generation and judgment. Nothing else.

Users see natural language and visual steps. Code is the compiled artifact that runs underneath — visible only if you want it.

---

## Ontology

| Concept | What it is | Example |
|---------|-----------|---------|
| **Jig** | A saved automation. Has a trigger, tools, steps. Lives in `jigs/`. | "My monthly invoice jig" |
| **Task** | A one-shot execution plan. Proposed by the assistant, approved by you, runs once. | "Draft a reply to Sarah" |
| **Run** | A single execution of a jig or task. The receipt. | "Invoice jig ran March 1 — 4 steps, 4.2s" |
| **Step** | One operation within a run. | "Read timesheet from Google Drive" |
| **Connection** | An authenticated service. | "Gmail ✓  Mercury ✓  Granola ✓" |
| **Action** | A specific capability on a connection. | "Gmail → search, draft, send" |
| **Assistant** | The default jig. Chat-triggered, read-only tools, can propose tasks. | "What meetings do I have tomorrow?" |

A **task** can be **promoted to a jig**: "I need this every month" → saves to `jigs/`, adds a trigger.

The **assistant** is itself a jig — the default one. Its special power is proposing tasks with explicit tools/steps for your approval.

---

## How It Works

### The Assistant (Chat)

The assistant is a jig with read-only tools. It answers questions freely. When you ask it to **do** something, it compiles a task.

**Read-only — no approval needed:**
> "What did Acme email me about last week?"
> → uses gmail.search, responds with results.

**Within standing permissions — just does it:**
> "Draft a reply saying we'll review by Friday."
> → gmail.draft is pre-authorized, creates draft, shows result.

**Needs elevation — proposes a task:**
> "Create an invoice on Mercury for this month."

```
Create March invoice for Acme Corp

1. Read timesheet from Google Drive
2. Find last invoice email
3. Compare hours — flag changes
4. Create invoice on Mercury ($25,200)

Will use: Drive (read) · Gmail (search) · Mercury (create invoice)

[Approve]  [Edit]  [Reject]
```

> [Approve] → runs deterministically, logged to runs/
> "I need this every month." → promoted to a jig with trigger `"every 1st 9am"`

### Standing Permissions

You set your trust level per action. The assistant operates within those bounds without asking.

```
Gmail
  ✓ Search          always allowed
  ✓ Read            always allowed
  ✓ Draft           always allowed
  ○ Send            ask every time
  ✗ Delete          never

Google Drive
  ✓ Read            always allowed
  ✗ Write           never

Mercury
  ○ Read            ask every time
  ○ Create invoice  ask every time
```

Three levels:
- **✓ Always** — assistant uses freely, no approval
- **○ Ask** — must propose a task, get approval
- **✗ Never** — blocked even if requested (guardrail)

Permissions build naturally through usage. Every approval shows: `□ Always allow this action` — upgrading ○ → ✓ inline. No settings page needed on day one.

**Multi-step with partial authorization:** the assistant runs pre-authorized steps silently, then pauses only at the permission boundary. Minimum friction, maximum visibility where it matters.

### Jigs (Saved Automations)

A jig is a saved, reusable automation with an explicit trigger and tool set.

#### Grouped Jigs — Same Workflow, Different Entities

A consultant running the same workflow for multiple clients uses **grouped jigs**: a folder where each file is a self-contained variant sharing the same jig ID.

```
jigs/
  weekly-update/           ← folder name = jig ID
    acme.ts                ← entity = "acme"
    globex.ts              ← entity = "globex"
    initech.ts             ← entity = "initech"
    _helpers.ts            ← underscore prefix = not a jig, shared code
  email-triage.ts          ← file in jigs/ = single-instance jig
```

**Discovery rules:**
- **File** directly in `jigs/` → single-instance jig, ID from filename
- **Folder** in `jigs/` → grouped jig, ID from folder name, each `.ts` file inside is a variant named by its filename
- **`_` prefix** → skip during discovery (shared helpers, colocated with the variants they serve)

**CLI + dashboard:**
```
jig run weekly-update              → which entity? [acme, globex, initech]
jig run weekly-update acme         → runs just acme
jig run weekly-update all          → runs all variants
```

Dashboard groups them:
```
weekly-update
  ├── acme       ✓ ran Friday 9:00am
  ├── globex     ✓ ran Friday 9:00am
  └── initech    ✗ failed Friday 9:00am
```

**Memory is the file.** Each variant is fully self-contained — all client-specific knowledge, preferences, quirks, and recipient lists live in the file itself. No indirection. Open the file, see everything. When you learn something new about a client ("their fiscal week starts Monday"), edit the file. Git commit. Done.

Each variant can diverge freely — different tools, different steps, different `llm()` prompts. They share a jig ID for grouping but are otherwise independent. Shared logic is extracted into `_helpers.ts` only when the repetition actually hurts — no premature abstraction.

**How jigs evolve:** The assistant or self-healing system can propose edits to a specific variant's file. Each edit is a git commit. The git history IS the memory of how the jig learned and adapted over time.

**What the user sees:**

```
Monthly Invoice — Acme Corp
Runs every 1st of the month at 9am

1. Read timesheet from Google Drive
   └─ Clients/Acme/timesheet-2026.xlsx
2. Find last invoice email
   └─ search: "subject:invoice to:billing@acme.co"
3. Compare hours and flag changes
   └─ uses AI to detect differences
4. Draft invoice email
   └─ creates Gmail draft
5. Wait for your approval
6. Send email

Tools: Google Drive (read) · Gmail (search, draft, send)

Last run: March 1 — ✓ Completed (4.2s)
Next run: April 1 at 9:00am

[Run now]  [Edit]  [View code]  [Copy trigger URL]  [Pause]
```

**What actually exists (visible via "View code"):**

```typescript
import { jig, llm } from "jig"
import { workspace } from "jig/connections"

export default jig("monthly-invoice-acme", {
  trigger: "every 1st 9am",
  tools: [workspace.drive_search, workspace.gmail_search, workspace.gmail_createDraft, workspace.gmail_send],
}, async (ctx) => {
  const timesheet = await workspace.drive_downloadFile({ fileId: "...", localPath: "/tmp/timesheet.xlsx" })
  const last = await workspace.gmail_search({ query: "subject:invoice to:billing@acme.co", maxResults: 1 })
  const diff = await llm("Compare hours, flag changes", { timesheet, last }, {
    schema: { changed: "boolean", summary: "string", hours: "number" }
  })
  const draft = await llm("Draft invoice email", { timesheet, diff })
  await workspace.gmail_createDraft({ to: "billing@acme.co", subject: "Invoice", body: draft })
  await ctx.human("Review draft", { show: draft, actions: ["approve", "edit", "reject"] })
  await workspace.gmail_send({ to: "billing@acme.co", subject: "Invoice", body: draft })
})
```

The natural-language view is derived from the code (AST parsing + SDK metadata). Edit the code → view updates. Edit via dashboard chat → code updates. One source of truth.

Most users never open "View code." Power users live there.

---

## Triggers

Every jig has a trigger:

- **Cron** — `"every friday 9am"`, `"every 1st 9am"`, `"every 30m"`
- **Event** — `"on gmail.newEmail matching 'urgent'"` (Composio/MCP webhooks)
- **Chat** — the assistant's trigger (always listening)
- **Manual** — `jig run <name>` or dashboard button
- **Webhook** — every jig gets a trigger URL automatically

### Webhook Triggers

Every jig gets a URL out of the box:

```
http://localhost:3141/trigger/monthly-invoice-acme?key=sk_a8f3...
```

Or exposed publicly (ngrok, Cloudflare tunnel, deployed):

```
https://jig.yourdomain.com/trigger/weekly-update?key=sk_a8f3...
```

Supports input parameters:

```
POST /trigger/monthly-invoice-acme?key=sk_a8f3...
Content-Type: application/json
{ "client": "Acme", "month": "march" }
```

Use cases:
- **Zapier/n8n calls Jig** — trigger from another automation tool
- **GitHub webhook** → triggers deploy review jig
- **iOS Shortcut** → "Hey Siri, run my invoice jig"
- **Bookmark** — click a link, jig runs
- **Other jigs** — one jig triggers another via URL

Dashboard shows **[Copy trigger URL]** on every jig. One click, clipboard.

---

## SDK

### Core

```typescript
import { jig, llm } from "jig"
import { workspace, granola } from "jig/connections"

export default jig("name", {
  trigger: "every friday 9am",
  tools: [workspace.gmail_search, workspace.gmail_createDraft],
}, async (ctx) => {
  // ... steps ...
})
```

- **`tools` array** — hard permission boundary. Not listed = can't be called. Code-enforced, not LLM-interpreted.
- **Durable** — each SDK `await` persists step results. On crash, resumes from last completed step. (Only SDK calls are memoized — `gmail.search`, `llm()`, `ctx.human()`, etc. — not arbitrary async functions.)
- **Observable** — every SDK call auto-tracked. No explicit logging needed.
- **Self-healing** — when a code step fails at runtime (unexpected data format, API change, edge case), the jig opens an LLM hatch to attempt repair before giving up. See [Self-Healing](#self-healing).

### Actions Inside Jigs

```typescript
// MCP tool calls (typed, generated after `jig connect`)
import { workspace, granola } from "jig/connections"

const emails = await workspace.gmail_search({ query: "subject:invoice", maxResults: 5 })
const meetings = await granola.list_meetings({ from: "2026-03-01" })
const events = await workspace.calendar_listEvents({ calendarId: "primary" })

// LLM — content generation and judgment
const draft = await llm("Write weekly update", { commits, meetings })

// Structured LLM output — when you need booleans, objects, not strings
const priority = await llm("Is this high priority?", { email }, {
  schema: { isHighPriority: "boolean", reason: "string" }
})

// Human approval — with rich payload
const approved = await ctx.human("Review invoice", {
  show: invoiceData,
  editable: true,
  actions: ["approve", "reject", "edit"],
})

// Parallel execution
const [emails, commits] = await ctx.parallel(
  gmail.search("subject:update"),
  github.listCommits({ since: "7d" })
)

// Batch processing — for large datasets that exceed LLM context
const flagged = await ctx.map(emails, 20, async (batch) => {
  return llm("Which need a reply?", { batch })
})

// Persistent state — remember across runs (for cron jigs)
const already = await ctx.state.get(`prepped:${meeting.id}`)
if (already) continue
await ctx.state.set(`prepped:${meeting.id}`, true, { ttl: "24h" })

// Secrets — never logged in runs/
const key = ctx.secret("MERCURY_API_KEY")

// Call another jig
await ctx.run("send-notification", { message: "Invoice approved" })
```

### Custom Tools

For APIs without Composio or MCP connectors:

```typescript
// tools/mercury.ts
import { defineTools } from "jig"

export const mercury = defineTools("mercury", {
  createInvoice: {
    method: "POST",
    url: "https://api.mercury.com/invoices",
    auth: "bearer",
    params: { amount: "number", client: "string", description: "string" }
  },
  listInvoices: {
    method: "GET",
    url: "https://api.mercury.com/invoices",
    auth: "bearer",
  }
})
```

Then use like any other tool:

```typescript
import { mercury } from "../tools/mercury"

export default jig("create-invoice", {
  tools: [mercury.createInvoice],
  // ...
})
```

---

## Self-Healing

Jigs are compiled and deterministic — but the world isn't. A timesheet format changes on run 47. An API returns a new field. An edge case appears that didn't exist at creation time.

When a code step fails, the jig doesn't just crash. It opens an **LLM hatch on failure**:

```
event → code → code → [FAIL] → [LLM heal] → code → result
                                    ↓
                              attempt to fix the step,
                              retry with corrected approach
```

### How It Works

1. A step throws an error (parse failure, unexpected data shape, API error)
2. The runtime catches it and opens an LLM hatch with:
   - The error message
   - The step's code + intent (from AST metadata)
   - The input data that caused the failure
   - The jig's tool permissions (LLM can only use tools in the `tools` array)
3. The LLM attempts to fix the step — e.g., parse the new timesheet format, handle the edge case
4. If the LLM succeeds → the run continues, and the healing is logged
5. If the LLM fails → the jig pauses and notifies the user with full context

### What Happens After Healing

The healing is logged in the run with a `healed: true` flag. If the same step heals repeatedly (same jig, same step, multiple runs), Jig suggests recompiling:

> "Step 3 of your invoice jig has self-healed 4 times this month. Want me to update the jig to handle this permanently?"

This closes the loop: compile → run → fail → heal → recompile. The jig evolves.

### Constraints

- The LLM can only use tools already in the jig's `tools` array — no permission escalation during healing
- Healing attempts are capped (default: 1 retry per step per run) — no infinite loops
- Every heal is logged with full context in the run record
- The user can disable self-healing per jig: `selfHeal: false`

This is the key difference from OpenClaw's approach: the LLM is not routing the happy path. It's a **safety net** for the unhappy path. Deterministic when things work, intelligent when they don't.

---

## Presentation Layer

The code is the **compiled artifact**. Users see a **natural-language + visual projection** derived from the code.

### Two Representations, One Source of Truth

| What the user sees | What actually exists |
|--------------------|--------------------|
| "Read timesheet from Google Drive" | `await drive.read("path/to/file.xlsx")` |
| "Search for last invoice email" | `await gmail.search("subject:invoice", { limit: 1 })` |
| "Compare hours using AI" | `await llm("Compare hours", { ... })` |
| "Wait for your approval" | `await ctx.human("Review", { ... })` |
| "Send email" | `await gmail.send(draft)` |

Generated from AST parsing + SDK call metadata at load time. No LLM needed for the basic view.

### Dashboard (v1)

Simple, functional web UI. No GenUI — just clean HTML pages:

- **Jigs list** — name, trigger, last run status, next run time
- **Run detail** — step-by-step timeline with results (rendered as formatted text/JSON)
- **Pending approvals** — `ctx.human()` interactions with action buttons
- **Connections** — connected services + permission levels
- **Assistant chat** — text input, conversation history, task proposals

Approval panels render the `show` payload as formatted data with action buttons. No fancy component selection — just sensible defaults (tables for arrays, text for strings, JSON for complex objects).

### GenUI Dashboard (v2 — future)

When v1 dashboard feels limiting, graduate to **Generative UI**: AI selects the right component for each data shape from a pre-built registry (InvoiceTable, EmailThread, CalendarView, etc.). Component selection should be **deterministic** (derived from SDK call metadata, not LLM-picked) — e.g., `gmail.search` always renders as an email list. LLM-based component selection only for ambiguous cases.

Frameworks to evaluate when ready: Tambo, Vercel AI SDK v6, CopilotKit + AG-UI, Google A2UI.

---

## Frontend: PWA (Exploring)

One idea worth exploring: ship the dashboard as a **Progressive Web App** so it doubles as the notification/approval channel on mobile.

Potential benefits:
- **Push notifications** — pending approvals, completions, urgent alerts
- **Installable** on phone home screen — feels native
- **One codebase** — no separate WhatsApp/Telegram integration needed

Open questions:
- PWA push notifications are still unreliable on iOS — may not be good enough for critical alerts
- Would users actually install a PWA, or is WhatsApp/Telegram more natural since they're already there?
- Might make more sense as v2 after the core dashboard is solid

---

## First Run

`npx create-jig` → opens `http://localhost:3141`:

1. Paste LLM API key → test call confirms
2. Connect one service (Gmail, Calendar, etc.) → OAuth
3. Chat opens → assistant works immediately

No wizard, no config files. Value in 2 minutes. Everything else discovered through usage.

---

## Distribution

Jig is a git clone. Upstream is the framework. Your clone has your jigs.

On `jig start`, clones auto-pull from upstream in the background. Upstream repos (no `upstream` remote) skip this check.

---

## Deployment

`jig start` detects your setup and asks interactively:

- **Local** — foreground process, good for chat and manual runs
- **Daemon** — background service via systemd/launchd, survives reboots
- **Expose** — daemon + Cloudflare Tunnel for public webhook URLs

CLI flags (`--daemon`, `--expose`) available for automation/scripts.

---

## Persistent Scheduler

Scheduler state in SQLite. On restart, any jig that missed its scheduled run executes once immediately, then resumes normal schedule.

---

## Error Handling

Built into the SDK. No boilerplate.

- **Transient errors** (timeouts, 429, 5xx) — automatic retries with backoff
- **Permanent failures** — self-healing attempted, then run fails and user is notified
- **Step timeouts** — sensible defaults, configurable per call

---

## Permission Resolution

**Jig `tools` array always wins.** Saved jigs use their declared tools. Standing permissions only govern the assistant's ad-hoc tasks.

**Jigs only run from their declared trigger.** A jig with `trigger: "every 1st 9am"` runs on that schedule — not from a random webhook or accidental `jig run`. This is default behavior, not opt-in. The `tools` array controls *what* a jig can do; the trigger controls *when* it can do it. Both are enforced by the runtime, not by the LLM.

---

## Cost Tracking

Every `llm()` call logs tokens + cost to SQLite automatically. `jig costs` shows monthly summary. Optional per-jig budgets pause and notify at limit.

---

## Runtime

Single Bun process started by `jig start`:

- **Jig Runner** — loads/executes .ts files from `jigs/`
- **Step Memoizer** — persists step results to SQLite, resumes on crash
- **Cron Scheduler** — triggers jigs on schedule
- **Event Listener** — MCP webhooks
- **Webhook Server** — trigger URLs for every jig
- **Approval Queue** — tracks `ctx.human()` waits
- **State Store** — persistent key-value for `ctx.state` (SQLite)
- **API Server** — dashboard + webhook receiver
- **File Watcher** — hot reloads jigs on change

### Storage: SQLite

All runtime data lives in a single `jig.db` file (via Bun's built-in `bun:sqlite`):

- **Runs** — execution history with step results, timing, status
- **State** — `ctx.state` key-value store with TTL
- **Approvals** — pending `ctx.human()` interactions

Why SQLite over JSON files:
- Concurrent reads/writes (WAL mode) — no corruption from parallel jig execution
- Queryable — "show me all runs that failed in the last week" is a SQL query
- No file proliferation — thousands of runs don't become thousands of files
- Still portable — one file, no database server, clone and go
- Bun has native SQLite support — zero dependencies

---

## Project Structure

```
my-jig/                    ← git repo
├── jigs/                  ← saved automations
│   ├── weekly-update/     ← grouped jig (one per client)
│   │   ├── acme.ts
│   │   ├── globex.ts
│   │   └── _helpers.ts    ← underscore = not a jig, shared code
│   ├── invoice/
│   │   ├── acme.ts
│   │   └── globex.ts
│   ├── email-triage.ts    ← single-instance jig (no folder)
│   └── meeting-prep.ts
├── tools/                 ← custom tool definitions
│   └── mercury.ts
├── jig.db                 ← runs, state, approvals (gitignored)
├── jig.config.ts          ← settings + standing permissions
├── .env                   ← API keys (gitignored)
└── package.json
```

The repo IS the system. Clone anywhere, `jig start`, it runs.

---

## Config

```typescript
import { defineConfig } from "jig"

export default defineConfig({
  llm: { model: "claude-sonnet-4-6", provider: "anthropic" },
  dashboard: { port: 3141 },

  // Standing permissions — what the assistant can do without asking
  permissions: {
    gmail:    { search: "always", read: "always", draft: "always", send: "ask", delete: "never" },
    drive:    { read: "always", write: "never" },
    calendar: { read: "always", create: "ask" },
    mercury:  { read: "ask", createInvoice: "ask" },
    github:   { read: "always", push: "never" },
  },
})
```

---

## Creating & Updating Jigs

Three paths, all produce the same `.ts` file:

- **Chat** — ask the assistant, it proposes a task, you say "save as jig" → writes to `jigs/`
- **CLI** — `jig new` / `jig edit <name>` → AI generates/modifies .ts files
- **Editor** — open .ts file directly, full TypeScript autocomplete
- **Dashboard** — edit via natural language, see changes as plain-English diff

Git tracks full history of all changes.

---

## CLI

```
jig start               — run daemon (cron, triggers, dashboard/PWA)
jig connect <service>   — OAuth via Composio / configure MCP
jig connections         — list connected services + permission levels
jig new                 — AI generates a jig from description
jig edit <name>         — AI modifies a jig
jig run <name>          — run a single-instance jig
jig run <name> <entity> — run a grouped jig for a specific entity
jig run <name> all      — run a grouped jig for all entities
jig runs                — list recent runs
jig approve             — list pending approvals
```

---

## Integrations

**MCP-only.** Jig is an MCP client. Integrations are MCP servers. One protocol, one SDK (`@modelcontextprotocol/sdk`).

### How it works

1. **Connect** — `jig connect <server>` authenticates via browser OAuth and discovers available tools
2. **Codegen** — Tool schemas are saved and TypeScript types generated (`.jig/types/*.d.ts`)
3. **Use** — AI reads generated types to produce workflow code with correct tool calls

### Predefined servers (ship with Jig)

| Service | MCP Server | Type |
|---|---|---|
| Gmail, Calendar, Drive, Docs, Sheets, Chat | `gemini-cli-extensions/workspace` | stdio (local, Apache 2.0) |
| Granola | `mcp.granola.ai/mcp` | remote |
| Slack | `mcp.slack.com/mcp` | remote |
| Notion | `mcp.notion.com/mcp` | remote |
| Linear | `mcp.linear.app/sse` | remote |

Users can also paste any MCP server URL to add custom integrations.

### Custom tools
`defineTools()` remains as an escape hatch for HTTP APIs without MCP servers.

```
$ jig connect workspace   → Browser OAuth → 56 Google Workspace tools available
$ jig connect granola     → Browser OAuth → 4 Granola tools available
$ jig connections         → Lists all connected servers + status
```

---

## Security

| Layer | Mechanism |
|-------|-----------|
| **Jig permissions** | `tools` array — code-enforced closed set per jig |
| **Standing permissions** | Per-action trust levels (always / ask / never) for assistant tasks |
| **Credentials** | MCP OAuth (browser-based) + `.env` for custom APIs — never in repo |
| **Webhook auth** | Per-jig secret keys on trigger URLs |
| **Audit** | Every action logged to SQLite with timing and results — queryable |
| **Versioning** | Git — full history of every jig change |

---

## Tech Stack

- **Runtime:** Bun
- **Integrations:** MCP servers + custom HTTP tools
- **LLM:** Anthropic Claude (configurable)
- **Storage:** SQLite via `bun:sqlite` — single file, no server
- **Frontend:** Web dashboard (v1: simple HTML + chat; v2: explore GenUI/PWA)
- **Distribution:** Git clone (upstream + private instance)

---

## Memory & State

Jig has three layers of memory, each with a different persistence model:

### 1. Jig Knowledge — the file IS the memory

Client-specific knowledge (preferences, quirks, recipients, formatting rules) lives directly in the jig file. No separate profiles, no config objects, no database lookups. Open the file, see everything.

When the system learns something new (self-healing discovers a pattern, user gives feedback), the jig file itself is edited. Each edit is a git commit. Git history is the memory of how each jig evolved.

For grouped jigs, each entity's variant file contains all knowledge about that entity. No indirection, no inheritance.

### 2. Runtime State — SQLite (`ctx.state`)

Operational state that changes between runs: "already prepped this meeting," "last invoice number," "token refresh timestamp." Key-value store with TTL in `jig.db`.

This is ephemeral operational data, not permanent knowledge. If you deleted `jig.db`, jigs would still know HOW to do their job (that's in the code). They'd just lose track of WHERE they left off.

### 3. Run History — SQLite (append-only)

Every run is logged with step results, timing, status, cost. Queryable. Never modified after write. The audit trail.

Self-healing events are logged here too — when a step heals repeatedly, the system suggests recompiling (editing the jig file), promoting runtime learning into permanent knowledge (layer 1).

### Design Principles

- **Knowledge in code, state in SQLite.** If it changes how the jig WORKS, it belongs in the file. If it tracks what the jig DID, it belongs in the database.
- **No vector databases, no graph databases, no external memory services.** SQLite + git covers everything.
- **The jig evolves by rewriting itself.** Self-healing → repeated healing → proposed rewrite → git commit. Memory is code evolution.
- **Agent self-curation is opt-in.** The assistant can propose edits to jig files (adding a learned preference), but the user approves via git diff. No invisible memory accumulation.

### Research Notes (March 2026)

Patterns evaluated from the broader agent ecosystem:

| Pattern | Used By | Decision |
|---------|---------|----------|
| Append-only event log + replay | Temporal, Restate, Inngest | Adopted for run history. Step memoization via replay matches Jig's durable `await` model. |
| Agent self-curating memory | OpenClaw, Claude Code, Letta | Adopted as jig evolution — but through code edits (visible, auditable), not opaque database writes. |
| Markdown files as memory | OpenClaw, NanoClaw, Claude Code | Jig goes further: the TypeScript file IS the memory. Code + knowledge unified. |
| LLM-driven memory curation (ADD/UPDATE/DELETE) | Mem0 | Not adopted. Adds complexity. Git + code edits achieve the same with full auditability. |
| Vector DB for memory retrieval | Mem0, Zep, CrewAI | Not adopted. Overkill for 20-30 jigs. File-based knowledge is directly addressable. |
| Temporal knowledge graphs | Zep/Graphiti | Not adopted for v1. Interesting for future if jigs need to reason about how facts changed over time. |
| Copy-on-write state branching | Replit | Interesting for future — fork jig state before risky external API calls. |
| CRDTs for state sync | Kleisli, SQLiteAI | Not needed yet. Relevant if Jig supports multi-device or collaborative editing. |

---

## Competitive Landscape

(Research conducted 2026-03-19)

### Market Signal: OpenClaw Fragility

Twitter shows significant user frustration:
- User had 110+ Obsidian pages deleted by OpenClaw
- Users migrating to Cowork/Dispatch, Town.com, Hermes, Zo
- "A lot of maintenance required" — skills need constant debugging
- "Full of footguns" — prompt-based permissions are dangerous
- Creator joining OpenAI — project moving to foundation

### Key Competitors (Updated March 23, 2026)

| Tool | Strength | Weakness vs Jig |
|------|----------|-----------------|
| **OpenClaw** (247k stars) | Huge ecosystem, self-curating memory | LLM-routed, prompt permissions, high maintenance |
| **IronClaw** (NEAR AI) | WASM sandbox, capability tokens | Heavy infra (Postgres), no workflow composition |
| **NanoClaw** | Container-isolated, secure | No workflow DSL, no durability |
| **Manus AI** (Meta) | Filesystem as memory, context tricks | Cloud VM only, no local-first |
| **n8n** | Visual builder, 500+ integrations | AI features immature |
| **Zapier** | 8000+ apps, best non-technical UX | Cloud-only, expensive, vendor lock-in |
| **Temporal** | Gold standard durability | Not an agent framework, massive complexity |

### Jig's Position

**Execution — how jigs run:**
```
OpenClaw:  LLM → LLM → LLM → LLM → LLM → result     (every step is LLM-routed)
Jig:       event → code → [LLM hatch] → code → result  (deterministic, LLM only where needed)
```

The LLM is not the router. It's a **hatch** — opened only when the jig needs content generation or judgment, closed immediately after. Everything else is code.

**Creation — how jigs are made:**
```
LLM → compiled jig (code)
```

The LLM's heavy lifting happens at **creation time**, not execution time. It writes the TypeScript. After that, the jig runs deterministically — the LLM is only invoked at explicit `llm()` hatch points within the compiled code.

This is the fundamental difference: OpenClaw burns tokens and risks errors on every run. Jig burns tokens once (at creation) and runs reliably forever after.

No existing tool combines: deterministic execution with LLM hatches, self-healing on failure, code-enforced permissions, human-in-the-loop approval with standing permissions, self-hosted git-native, and an interactive assistant that compiles tasks into automations.

The pitch: **"Day one, it's your assistant. Day thirty, it runs your business."**

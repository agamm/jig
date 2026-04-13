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
| **Jig** | A saved automation. Has a trigger, tools, and step structure. Lives in `jigs/`. | "My monthly invoice jig" |
| **Run** | A single execution of a jig. The receipt. | "Invoice jig ran March 1 — 4 steps, 4.2s" |
| **Step** | One operation within a run. | "Read timesheet from Google Drive" |
| **Connection** | An authenticated service. | "Gmail ✓  Mercury ✓  Granola ✓" |
| **Tool** | A specific capability exposed by a connection. | "Gmail → search, draft" |
| **Authoring Agent** | The dashboard/CLI backend flow that creates or edits jigs from natural language. | "Create a weekly update jig" |

---

## How It Works

### Authoring Agent

The dashboard and CLI both talk to the same backend authoring flow. You describe the automation you want, and the backend:

1. Resolves which connected servers the jig needs
2. Applies any server-specific authoring strategy
3. Generates TypeScript against the connected/generated tool surface
4. Validates the jig and fixes errors before saving

The server-specific rule matters:
- Default servers expose their generated `.d.ts` and schema tool surface directly
- `apify` may do build-time Actor discovery, then generate runtime code against the resolved Actor path
- `composio` may do config-driven proxy discovery, then expose the discovered connected-tool surface rather than raw meta-tools

### Jigs (Saved Automations)

A jig is a saved, reusable automation with an explicit trigger and tool set.

Jigs are plain `.ts` files in `jigs/`.

**Discovery rules:**
- **File** directly in `jigs/` → jig, ID from filename
- **`_` prefix** → skip during discovery (shared helpers, examples)

**How jigs evolve:** The assistant or self-healing system can propose edits to a jig file. Each edit is a git commit. The git history IS the memory of how the jig learned and adapted over time.

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

Tools: Google Drive (read) · Gmail (search, draft)

Last run: March 1 — ✓ Completed (4.2s)
Next run: April 1 at 9:00am

[Run now]  [Edit]  [View code]  [Copy trigger URL]  [Pause]
```

**What actually exists (visible via "View code"):**

```typescript
import { jig, llm } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace.js"

export default jig("monthly-invoice-acme", {
  trigger: { type: "cron", cron: "0 9 1 * *" },
  tools: [workspace.drive_search, workspace.gmail_search, workspace.gmail_createDraft],
}, async (ctx) => {
  let timesheet: unknown
  let lastInvoice: unknown

  await ctx.step("Find source documents", [workspace.drive_search, workspace.gmail_search], async () => {
    timesheet = await workspace.drive_search({ query: "Acme timesheet March" })
    lastInvoice = await workspace.gmail_search({ query: "subject:invoice to:billing@acme.co", maxResults: 1 })
  })

  await ctx.step("Draft invoice email", [workspace.gmail_createDraft], async () => {
    const draft = await llm("Draft invoice email", { timesheet, lastInvoice })
    await workspace.gmail_createDraft({ to: "billing@acme.co", subject: "Invoice", body: draft as string })
  })
})
```

The natural-language view is derived from the code (AST parsing + SDK metadata). Edit the code → view updates. Edit via dashboard chat → code updates. One source of truth.

Most users never open "View code." Power users live there.

---

## Triggers

Every jig has a trigger:

- **Cron** — `"every friday 9am"`, `"every 1st 9am"`, `"every 30m"`
- **Manual** — `jig run <name>` or dashboard button
- **Webhook** — every jig gets a trigger URL automatically

### Webhook Triggers

Every jig gets a URL out of the box:

```
http://localhost:3141/api/webhooks/monthly-invoice-acme?token=sk_a8f3...
```

Or exposed publicly (ngrok, Cloudflare tunnel, deployed):

```
https://jig.yourdomain.com/api/webhooks/weekly-update?token=sk_a8f3...
```

Supports input parameters:

```
POST /api/webhooks/monthly-invoice-acme?token=sk_a8f3...
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
import { jig, llm } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace.js"

export default jig("name", {
  trigger: { type: "cron", cron: "0 9 * * 5" },
  tools: [workspace.gmail_search, workspace.gmail_createDraft],
}, async (ctx) => {
  // ... steps ...
})
```

- **`tools` array** — hard permission boundary. Not listed = can't be called. Code-enforced, not LLM-interpreted.
- **Observable** — runs and steps are tracked by the runtime and shown in the dashboard/API.
- **Scoped** — runtime code should stay on the generated connection surface; authoring-time discovery should not leak back into jig runtime code.
- **Self-healing** — when a code step fails at runtime (unexpected data format, API change, edge case), the jig opens an LLM hatch to attempt repair before giving up. See [Self-Healing](#self-healing).

### Actions Inside Jigs

```typescript
// MCP tool calls (typed, generated after `jig connect`)
import { jig, llm } from "@jig/sdk"
import { workspace } from "@jig/connections/workspace.js"

export default jig("weekly-update", {
  trigger: { type: "manual" },
  tools: [workspace.calendar_listEvents, workspace.gmail_search, workspace.gmail_createDraft],
}, async (ctx) => {
  let meetings: unknown
  let emails: unknown

  await ctx.step("Gather source data", [workspace.calendar_listEvents, workspace.gmail_search], async () => {
    meetings = await workspace.calendar_listEvents({ calendarId: "primary" })
    emails = await workspace.gmail_search({ query: "label:inbox newer_than:7d", maxResults: 20 })
  })

  await ctx.step("Draft summary", [workspace.gmail_createDraft], async () => {
    const draft = await llm("Write a weekly update email", { meetings, emails })
    await workspace.gmail_createDraft({ to: "team@example.com", subject: "Weekly update", body: draft as string })
  })
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
| "Draft invoice email" | `await workspace.gmail_createDraft({ ... })` |

Generated from AST parsing + SDK call metadata at load time. No LLM needed for the basic view.

### Dashboard (v1)

Simple, functional web UI. No GenUI — just clean HTML pages:

- **Jigs list** — name, trigger, last run status, next run time
- **Run detail** — step-by-step timeline with results (rendered as formatted text/JSON)
- **Connections** — connected services + tool surfaces
- **Authoring chat** — text input, agent activity, jig generation/editing

### GenUI Dashboard (v2 — future)

When v1 dashboard feels limiting, graduate to **Generative UI**: AI selects the right component for each data shape from a pre-built registry (InvoiceTable, EmailThread, CalendarView, etc.). Component selection should be **deterministic** (derived from SDK call metadata, not LLM-picked) — e.g., `gmail.search` always renders as an email list. LLM-based component selection only for ambiguous cases.

Frameworks to evaluate when ready: Tambo, Vercel AI SDK v6, CopilotKit + AG-UI, Google A2UI.

---

## Frontend: PWA (Exploring)

One idea worth exploring: ship the dashboard as a **Progressive Web App** so it doubles as the notification channel on mobile.

Potential benefits:
- **Push notifications** — completions, failures, urgent alerts
- **Installable** on phone home screen — feels native
- **One codebase** — no separate WhatsApp/Telegram integration needed

Open questions:
- PWA push notifications are still unreliable on iOS — may not be good enough for critical alerts
- Would users actually install a PWA, or is WhatsApp/Telegram more natural since they're already there?
- Might make more sense as v2 after the core dashboard is solid

---

## First Run

`jig start` opens `http://localhost:3141`:

1. Start the dashboard and API server
2. Connect one service (Workspace, GitHub, Apify, etc.)
3. Create the first jig from natural language

No wizard, no config files. Value in 2 minutes. Everything else discovered through usage.

---

## Distribution

Jig is a git repo. Upstream is the framework. Your clone has your jigs.

When you want updates from upstream, use `jig update`.

---

## Deployment

Current default flow is local: run `jig start` for the dashboard + API server. Background-service and public-expose workflows are future deployment work, not current guaranteed product surface.

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

**Jig `tools` array always wins.** Saved jigs use their declared tools. Authoring may discover or resolve runtime targets at build time, but the saved jig runtime still runs only against its declared tool surface.

**Jigs only run from their declared trigger.** A jig with `trigger: { type: "cron", cron: "0 9 1 * *" }` runs on that schedule, while `{ type: "manual" }` and `{ type: "webhook" }` behave as named. The `tools` array controls *what* a jig can do; the trigger controls *when* it can do it. Both are enforced by the runtime, not by the LLM.

---

## Cost Tracking

Every `llm()` call logs tokens + cost to SQLite automatically. `jig costs` shows monthly summary. Optional per-jig budgets pause and notify at limit.

---

## Runtime

Single Bun process started by `jig start`:

- **Jig Runner** — loads/executes .ts files from `jigs/`
- **Run/Step Tracker** — records step results, timing, and status to SQLite
- **Cron Scheduler** — triggers jigs on schedule
- **Webhook Server** — trigger URLs for every jig
- **API Server** — dashboard + webhook receiver

### Storage: SQLite

All runtime data lives in a single `jig.db` file (via Bun's built-in `bun:sqlite`):

- **Runs** — execution history with step results, timing, status

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
│   ├── _helpers.ts        ← underscore = not a jig, shared code
│   ├── email-triage.ts
│   └── meeting-prep.ts
├── .jig/                  ← generated schemas, connection modules, types
├── jig.db                 ← runs and runtime state (gitignored)
├── .env                   ← API keys (gitignored)
└── package.json
```

The repo IS the system. Clone anywhere, `jig start`, it runs.

---

## Creating & Updating Jigs

Three paths, all produce the same `.ts` file:

- **Chat** — describe a jig in natural language, the backend agent writes it to `jigs/`
- **CLI** — `jig new` / `jig edit <name>` → AI generates/modifies .ts files
- **Editor** — open .ts file directly, full TypeScript autocomplete
- **Dashboard** — edit via natural language, see changes as plain-English diff

Git tracks full history of all changes.

---

## CLI

``` 
jig start               — start dashboard + API server
jig connect <service>   — connect and generate tool artifacts
jig new                 — AI generates a jig from description
jig edit <name>         — AI modifies a jig
jig run <name>          — run a jig
jig update              — pull latest from upstream
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
| GitHub | `api.githubcopilot.com/mcp/` | remote |
| Apify | `mcp.apify.com` | remote |
| Composio | `connect.composio.dev/mcp` | remote proxy/discovery |

Users can also paste any MCP server URL to add custom integrations.

```
$ jig connect workspace   → Browser OAuth → generated Workspace tool surface
$ jig connect apify       → generated Apify connection surface
$ jig connect composio    → proxy discovery → generated connected-tool surface
```

---

## Security

| Layer | Mechanism |
|-------|-----------|
| **Jig permissions** | `tools` array — code-enforced closed set per jig |
| **Credentials** | MCP OAuth / configured auth commands + SQLite credential storage — never in repo |
| **Webhook auth** | Per-jig secret keys on trigger URLs |
| **Audit** | Every action logged to SQLite with timing and results — queryable |
| **Versioning** | Git — full history of every jig change |

---

## Tech Stack

- **Runtime:** Bun
- **Integrations:** MCP servers + generated connection modules
- **LLM:** OpenRouter-backed model selection
- **Storage:** SQLite via `bun:sqlite` — single file, no server
- **Frontend:** Web dashboard (v1: simple HTML + chat; v2: explore GenUI/PWA)
- **Distribution:** Git clone (upstream + private instance)

---

## Memory & State

Jig has three layers of memory, each with a different persistence model:

### 1. Jig Knowledge — the file IS the memory

Client-specific knowledge (preferences, quirks, recipients, formatting rules) lives directly in the jig file. No separate profiles, no config objects, no database lookups. Open the file, see everything.

When the system learns something new (self-healing discovers a pattern, user gives feedback), the jig file itself is edited. Each edit is a git commit. Git history is the memory of how each jig evolved.

### 2. Runtime State — SQLite (future)

Operational state between runs is a plausible future addition, but the current codebase should not assume a public `ctx.state` API exists until it is implemented and documented as real runtime surface.

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

No existing tool combines: deterministic execution with LLM hatches, self-healing on failure, code-enforced permissions, self-hosted git-native operation, and an interactive assistant that compiles natural-language requests into automations.

The pitch: **"Day one, it's your assistant. Day thirty, it runs your business."**

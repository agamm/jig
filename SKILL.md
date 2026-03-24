---
name: jig-writing
description: How to write jigs using the Jig SDK. Use when creating new jigs, refactoring existing ones, or deciding how to structure a workflow. Covers jig(), llm(), agent(), connections, and the core principle of compiling what you can while keeping agent() for fuzzy judgment.
---

# Writing Jigs

Jigs are deterministic units of work with LLM "hatches" — points where intelligence
is needed for content generation, judgment, or fuzzy data gathering. Everything else
is code.

```
event → code → [agent hatch] → code → [llm hatch] → code → result
                 fuzzy                   content        deterministic
```

The goal: minimize what the LLM does at runtime. If you can hardcode it, hardcode it.

## SDK

### `jig(name, options, handler)`

Define a jig. The `tools` array is the permission boundary — nothing outside it can be called.

```typescript
import { jig, llm, agent } from "../src/index.js"
import { granola } from "../.jig/connections/granola.js"
import { workspace } from "../.jig/connections/workspace.js"

const myJig = jig("my-jig", {
  params: {
    company: "Company or project name",       // description, not type
    recipient: "Email address for the draft",
  },
  tools: [granola.list_meetings, workspace.gmail_createDraft],
}, async (ctx) => {
  const { company, recipient } = ctx.params
  // ...
})

export default myJig
```

### `run(definition, params)` — called by the CLI, not by jig files

Jig files just `export default myJig`. The CLI imports and calls `run()`.

```typescript
// In jig files: just export
export default myJig

// The CLI handles execution, param prompting, dry-run, etc.
```

### `llm(prompt, data, options?)`

Content generation or judgment. No tool access. Deterministic for the same input.

```typescript
// Plain text
const email = await llm("Write a summary", { meetings, commits }) as string

// Structured output
const result = await llm("Classify this", { text }, {
  schema: { priority: "string", urgent: "boolean" }
})
// → { priority: "high", urgent: true }
```

### `agent(prompt, tools)`

LLM with bounded tool calling. The agent decides which tools to call, how many
times, and in what order — but only from the tools you give it.

```typescript
const data = await agent(
  "Find all meetings and emails about this project from last week",
  [granola.query_granola_meetings, workspace.gmail_search, workspace.gmail_get]
)
```

This is the "bigger hatch" — use it when the task requires judgment about
*how* to gather or process data. The agent might search, read results, search
again with a refined query, etc.

### `ctx.log(...args)`

Write output. Never use `console.log()` in jig handlers — always `ctx.log()`.
Output is captured by the runtime for dry-run, dashboard display, and testing.

```typescript
ctx.log(result.email)
ctx.log(`Draft: https://mail.google.com/mail/u/0/#drafts/${id}`)
```

### `ctx.parallel(...promises)`

Run multiple promises concurrently. Sugar over `Promise.all` with proper typing.

```typescript
const [meetings, emails] = await ctx.parallel(
  granola.list_meetings({ time_range: "last_week" }),
  workspace.gmail_search({ query: company }),
)
```

### Connections

Import from `.jig/connections/`. Auto-generated after `jig connect <server>`.
Tools connect lazily on first call — no setup code needed.

```typescript
import { granola } from "../.jig/connections/granola.js"
import { workspace } from "../.jig/connections/workspace.js"
import { github } from "../.jig/connections/github.js"
```

---

## The Core Principle

**Compile what you can.** A jig should be as deterministic as possible.
Use `agent()` only where you genuinely need fuzzy judgment.

### When to use `agent()` (fuzzy, needs judgment)

- Searching for relevant data: "find meetings about this company"
- Deciding what's important: "which of these emails matter?"
- Discovery: "find the GitHub repo matching this name"
- Multi-step gathering where the next step depends on what was found

### When to use `llm()` (deterministic given data)

- Writing content from known data: "write an email from these notes"
- Structured extraction: "extract action items from this summary"
- Classification or judgment on known input: "is this high priority?"

### When to use direct tool calls (pure code)

- Actions with side effects: creating drafts, sending emails
- Steps that should always happen in a fixed order
- API calls where you know exactly what to fetch
- Date math, string formatting, control flow

### When to write plain code (no LLM at all)

- Calculating dates, building file paths, formatting strings
- Conditional logic based on params
- Combining or restructuring data between steps

---

## Pattern: Maximize Determinism

The best jigs push as much as possible into code. The determinism hierarchy:

1. **Direct tool calls / code** — known params, always the same (most deterministic)
2. **`llm()`** — one LLM call, no tool access, deterministic given the same input
3. **`agent()`** — LLM with tools, multiple calls, variable order (least deterministic)

Before using `agent()`, ask: "Do I know the tool name and params at write time?"
- `list_meetings({ time_range: "last_week" })` → **yes, direct call**
- `gmail_search({ query: "from:client subject:invoice" })` → **yes, direct call**
- "extract action items from this text" → **llm() — synthesis from known data**
- "search for relevant data, read the best results, then search deeper" → **agent() — fuzzy multi-step**

```typescript
async (ctx) => {
  // 1. Direct calls — known params, always the same
  const data = await someConnection.list_items({ time_range: "last_week" })

  // 2. Agent — only for steps that need judgment about what to fetch next
  const details = await agent("Dig deeper into the most relevant items", [...tools], { data })

  // 3. LLM — synthesize from gathered data (deterministic given input)
  const summary = await llm("Summarize key insights", { data, details })

  // 4. Code acts — deterministic side effects
  await someConnection.create_draft({ body: summary as string })
}
```

### Why not one big `agent()` call?

Wrapping everything in `agent()` is the pattern Jig exists to eliminate:

- **Token cost** — the LLM routes every step, every run
- **Unreliable** — the agent might skip steps or call them in wrong order
- **Not compilable** — no stable pattern to observe and optimize later
- **Debugging** — you can't tell what the agent decided to do

### Why not all deterministic?

Some tasks genuinely need judgment:

- "Which of these 50 meetings are about this client?" — you can't hardcode this
- "Search Gmail, then read the 5 most relevant results" — relevance is fuzzy
- "Find the GitHub repo matching 'project-name'" — needs search + judgment

The agent handles edge cases you didn't anticipate. But fence it in.

---

## Tool Organization

Split tools by purpose. Gather tools go to `agent()`. Action tools are called
directly in code.

```typescript
// Gathering — given to agent()
const gatherTools = [
  granola.query_granola_meetings,
  workspace.gmail_search,
  workspace.gmail_get,
  github.search_repositories,
  github.list_commits,
]

// Action — called directly, never given to agent
// workspace.gmail_createDraft

const myJig = jig("my-jig", {
  // All tools in permission boundary
  tools: [...gatherTools, workspace.gmail_createDraft],
}, async (ctx) => {
  // Agent only gets gather tools
  const data = await agent("Find data about ...", gatherTools)

  const content = await llm("Write email from ...", { data }) as string

  // Action called directly — always happens, in the right order
  await workspace.gmail_createDraft({ subject: "...", body: content })
})
```

---

## Multiple Agent Steps

You can use multiple `agent()` calls to control the flow while keeping
each step fuzzy. This gives you ordering guarantees without hardcoding
the tool calls within each step.

```typescript
async (ctx) => {
  // Step 1: Find relevant meetings (agent decides which tools, how many calls)
  const meetings = await agent("Find meetings about X", [
    granola.query_granola_meetings, granola.get_meetings,
  ])

  // Step 2: Find relevant emails (separate agent, separate focus)
  const emails = await agent("Find emails about X", [
    workspace.gmail_search, workspace.gmail_get,
  ])

  // Step 3: Write content (deterministic)
  const email = await llm("Write update from meetings and emails", { meetings, emails })

  // Step 4: Act (deterministic)
  await workspace.gmail_createDraft({ ... })
}
```

This is more controlled than one giant agent call, but still flexible
within each step.

---

## Agent Compilation (Future)

When `agent()` is used, Jig will eventually observe tool call patterns:

```
Run 1: agent → [gmail_search] → [gmail_get x3] → result
Run 2: agent → [gmail_search] → [gmail_get x3] → result
Run 3: agent → [gmail_search] → [gmail_get x3] → result
         ↓ pattern stabilizes → compile
Run 4: gmail_search() → gmail_get() x3 → result  (no LLM, no tokens)
```

If a compiled step fails, it falls back to `agent()` to self-heal,
then recompiles with the new pattern.

Write jigs with this in mind: the clearer the boundary between agentic and
deterministic code, the easier it is to compile the agentic parts later.

---

## Check Tool Schemas Before Writing Jigs

Before calling any tool directly in code, read its schema from `.jig/schemas/`
to understand required params, types, and enum values. MCP tools will reject
calls with missing required fields.

```bash
# Quick way to check a tool's schema
cat .jig/schemas/workspace.json | bun -e "
  const tools = JSON.parse(await Bun.stdin.text())
  const t = tools.find(t => t.name === 'gmail_createDraft')
  console.log(JSON.stringify(t.inputSchema, null, 2))
"
```

Common mistakes:
- Calling a tool without a required param (e.g. `gmail_createDraft` needs `to`)
- Using wrong param names (e.g. `query` vs `search_terms`)
- Passing wrong types (e.g. string where array expected)
- Using values outside an enum (e.g. `time_range` only accepts specific strings)

The agent handles this automatically (it reads schemas), but direct calls
in code are your responsibility.

---

## Let the Agent Figure Out What You Don't Know

Don't hardcode things the agent can infer from context. If the agent already
gathered meeting data with participant emails, it knows who the recipient is.

Instead of asking the user for a recipient:
```typescript
// Don't do this — forces the user to provide what the data already contains
params: { recipient: "Email address" }
```

Have the agent figure it out during its pass — it already has the data:
```typescript
const result = await agent(
  `... gather data and write the email ...
At the end, on a separate line write:
RECIPIENT: <email of the primary contact from meetings/emails>`,
  gatherTools
)

const match = result.match(/RECIPIENT:\s*(.+@.+)\s*$/m)
const recipient = match?.[1]?.trim()
```

General rule: if the answer exists in data the agent already gathered,
let the agent extract it in the same pass rather than adding another LLM call.

---

## Things to Think About

Not rules — just patterns worth considering when writing jigs.

- **Prefer shorter agent prompts.** The agent is smart — state what you want and what constraints matter, not step-by-step instructions. A concise prompt that names data sources and rules usually outperforms a verbose one.
- **Recurring jigs should diff against their last run.** Without context from the previous output, the agent treats every piece of gathered data as novel and repeats itself.
- **Deduplicate across data sources.** The same event often shows up in meetings, emails, and calendar. Prompt the agent to merge, not echo.
- **How much context is too much?** A broad time window can blow up the context and dilute relevance. Consider a two-pass approach: broad search → relevance filter → detailed read.

---

## Reference: Weekly Update Jig

See `jigs/weekly-update/` for a grouped jig example demonstrating:

- Agent gathering + email writing in one pass (fuzzy data + content)
- LLM recipient extraction from gathered context (structured judgment)
- Deterministic Gmail draft creation (action, always last)
- Tool separation (gather tools to agent, action tools called directly)
- Per-client variants with self-contained knowledge

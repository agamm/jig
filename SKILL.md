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
import { jig, llm, agent } from "@jig/sdk"
import { granola } from "@jig/connections/granola.js"
import { workspace } from "@jig/connections/workspace.js"

const myJig = jig("my-jig", {
  tools: [granola.list_meetings, workspace.gmail_createDraft],
}, async (ctx) => {
  const company = "Acme"
  const recipient = "client@example.com"
  // ...
})

export default myJig
```

If a jig does not need user-supplied inputs, omit `params` entirely. Do not add placeholder
or speculative params just because a jig could theoretically be configurable.

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

### `ctx.output(...args)`

Write output. Never use `console.log()` in jig handlers — always `ctx.output()`.
Output is captured by the runtime for dry-run, dashboard display, and testing.

```typescript
ctx.output(result.email)
ctx.output(`Draft: https://mail.google.com/mail/u/0/#drafts/${id}`)
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

Import from `@jig/connections/`. Auto-generated after `jig connect <server>`.
Tools connect lazily on first call — no setup code needed.

```typescript
import { granola } from "@jig/connections/granola.js"
import { workspace } from "@jig/connections/workspace.js"
import { github } from "@jig/connections/github.js"
```

---

## Jig Writing Rules (must follow)

These rules are enforced by the runner and the static validator. Violations
cause the jig to refuse to run with a clear error.

### 1. Maximize determinism (most important)
Prefer direct tool calls > `llm()` > `agent()`:
- Direct call when you know the tool + params at write time
- `llm()` for synthesis, writing, or classification from known data
- `agent()` only when the sequence of tool calls requires runtime judgment
- Default to breaking large workflows into deterministic steps instead of one giant `agent()`

### 2. Structure with `ctx.step()` blocks (REQUIRED, enforced)

**Every jig MUST wrap its work in at least one `ctx.step()` block.** Tool calls
outside a step throw at runtime. Jigs with zero steps are rejected by the
validator.

`ctx.step()` is purely a labeled scope. **Do NOT assign its return value** —
pass data between steps using `let` variables in the outer handler scope.

```typescript
let events: any[] = []
await ctx.step("Get calendar events", [calendar_listEvents], async () => {
  events = await calendar_listEvents({...})
  ctx.output(`Found ${events.length} events`)
})
await ctx.step("Send Telegram", [telegram_send_message], async () => {
  await telegram_send_message({ chat_id: CHAT_ID, text: format(events) })
})
```

Rules:
- Wrap every logical group of tool calls in a `ctx.step()` block
- Each step declares exactly which tools it uses — only those tools work inside the block
- Every connection tool used inside a step callback MUST appear in that same step's tools array. If you call `apify.call_actor` and then `apify.get_actor_output`, either declare both tools in that step or, preferably, split them into two sequential steps.
- If you violate the step tool allowlist, runtime fails with an error like: `Tool "apify.get-actor-output" is not allowed in step "Scrape GitHub trending repos". Declare it in the tools array of your ctx.step() call.`
- **Steps MUST be flat — never nest `ctx.step()` inside another `ctx.step()` callback. The runtime AND the static validator throw if you do.**
- Conditional early-return is fine, but the early-return path must NOT contain another `ctx.step()` — finish the current step, then branch in the outer handler.
- `agent()` and `llm()` calls are always allowed inside any step — they don't need to be in the tools array
- Step labels MUST be static strings — never use template literals with runtime variables. Good: `"Research meeting context"`. Bad: `` `Research: ${eventSummary}` ``
- ALL `ctx.output()` calls must be inside `ctx.step()` blocks — output is tied to the step it belongs to
- Use `ctx.output()` inside steps to show progress

### 3. Do NOT declare jig params
- Do NOT declare `options.params` in a jig. Human-configured jig params are no longer supported.
- If the request already specifies the value, hardcode it.
- If you need a constant that the user did not provide, ask the user, then hardcode their answer.
- `ctx.params` still exists at runtime for incoming webhook/manual payloads passed in externally. Use it only for intrinsic runtime payload data, not for declared jig configuration.

### 4. Hardcode constants, don't discover them at runtime
- If the jig needs a value that is constant across runs (the user's email, name, team, Slack channel, timezone, recipient list, etc.), prefer hardcoding it over discovering it at runtime
- If you don't know a constant, ask the user before writing code. Keep the question short: "What email should I send the briefing to?" Then hardcode their answer.
- Do not turn those constants into jig params
- When an LLM analyzes the user's own data (inbox, calendar, DMs, files), pass identity into the prompt (`"the user = <name> <email>"`) **and** filter self-originated records at the source (`-from:me`, organizer-equals-me, etc.) — otherwise the LLM will suggest you reply to your own sent mail

### 5. Use the right tools
The available tools and probe results show what's available. Use multiple relevant tools when they materially improve the result.

If the requested workflow depends on a specific connection, MCP server, or tool, the jig MUST actually use it. Do not degrade into a no-op jig that only explains setup steps.

Forbidden patterns:
- Do NOT tell the user to run `jig connect ...` from inside jig output
- Do NOT emit placeholder copy like "Once connected, this jig will..."
- Do NOT use `llm()` to fabricate "example output" for a tool you failed to call
- Do NOT replace a missing integration with generic prose or mocked/sample results

If the required connection or tool is unavailable, stop creation/editing and surface the missing dependency instead of writing placeholder code.

### 6. Preserve the existing toolset when editing
- If you are editing an existing jig, do NOT add or remove tools unless the user explicitly asked for tool changes
- Small logic, wording, output, or scheduling edits should usually keep the existing tools unchanged
- Only change the toolset when the current tools are insufficient or invalid for the requested behavior

### 7. Edit existing jigs surgically
When editing an existing jig, treat the current file as the source of truth.
The user usually wants a narrow patch, not a rewrite.

Before writing:
- Identify the exact requested behavior change.
- Locate the smallest code region that implements that behavior.
- Preserve the existing trigger, schedule, recipients, subject lines, constants, data sources, step labels, step ordering, and output shape unless the user explicitly asks to change them.
- Preserve existing formatting modes. If a jig sends HTML, keep sending HTML. If the user asks for HTML but the schema says the field is `isHtml`, use `isHtml: true` rather than inventing unsupported fields like `contentType`.
- Preserve the current tool list unless Rule 6 says it must change.
- Do not "simplify", collapse steps, remove data gathering, replace deterministic code with `llm()`/`agent()`, or remove user-visible sections just because they seem verbose.
- Do not call `read_jig_file` if the current jig code is already in the prompt context. Use the provided code.
- After the edit, run `check_jig`. If it fails, patch the narrow error and check again.

Bad edit behavior:
```typescript
// User asked: "make the email body HTML"
// Bad: rewrite the whole jig, remove HTML conversion, shorten the workflow,
// change the subject, and send plain text.
```

Good edit behavior:
```typescript
// User asked: "make the email body HTML"
const htmlBody = markdownToHtml(markdownBody)
await workspace.gmail_send({
  to: "user@example.com",
  subject,
  body: htmlBody,
  isHtml: true,
})
```

### 8. Pick the right trigger (ASK if unclear)

Every jig has exactly one `trigger` field. The three types:

- `{ type: "manual" }` — user runs it from the CLI or dashboard button. No schedule, no external input. Use for one-off tasks, interactive workflows, or jigs triggered only by a human click.
- `{ type: "cron", cron: "0 8 * * 1" }` — runs on a schedule (5-field cron: min hour day-of-month month day-of-week). Examples: `"0 8 * * 1"` = Mon 8am, `"*/15 * * * *"` = every 15 min, `"0 9 * * 1-5"` = weekdays 9am. Use for digests, reminders, periodic sync, reports.
- `{ type: "webhook" }` — runs when an external service POSTs to `/api/webhooks/{jigId}?token=...`. The POST body becomes `ctx.params` (nested JSON). Use for incoming messages from Telegram, Slack events, GitHub webhooks, email inbound parse, etc.

**Webhook body is nested JSON.** Telegram sends `{ update_id, message: { text, chat: { id }, from: {...} } }`. Access via:
```typescript
const msg = ctx.params.message as any
const text = msg?.text ?? ""
const chatId = String(msg?.chat?.id ?? "")
```
Always cast to `any` for nested webhook shapes; jigs don't get typed payloads.

**If the user's description doesn't make the trigger obvious, STOP and ask.** Do not default to `"manual"` silently — that's usually wrong.

Interpret explicit trigger language as decisive:
- If the user says `manual`, `run manually`, `on demand`, `when I click Run`, or similar, use `{ type: "manual" }` and do not ask again.
- If the user says `every morning`, `weekly`, `every Monday`, `on a schedule`, `cron`, or similar, use `{ type: "cron", ... }` and do not ask again.
- If the user says `webhook`, `POST`, `incoming event`, `Telegram message`, or similar event-driven language, use `{ type: "webhook" }` and do not ask again.
- If a request contains both a clear trigger and other timing words used only as content context, the clear trigger wins. Example: "manual run, find weekly trending GitHub repos" is still manual.
- Strong precedence: explicit trigger wording also wins over timing words that only describe the data window or content, such as "last week", "daily summary", or "weekly trending".

Good clarifying questions:
- "Should this run on a schedule (e.g. every morning at 8am) or only when you click Run?"
- "Is this triggered by an incoming Telegram message, or on a fixed schedule?"
- "Should this fire every time a webhook comes in, or just once manually?"

### 9. `ctx.output()` must show the real data, not just counts

Every `ctx.output()` should let a human reviewing the run see *what happened*, not just *how many*. Bullet list the gathered items with their key identifying fields (date + title, subject + sender, event + time). A short excerpt or summary is welcome. A single "Found N items" line is never enough.

Bad:
```typescript
ctx.output(`Found ${meetings.length} meetings`)
```

Good:
```typescript
const preview = meetings
  .slice(0, 10)
  .map((m) => `- ${m.date} — **${m.title}**`)
  .join("\n")
ctx.output(`Found ${meetings.length} meetings\n\n${preview}`)
```

### 10. Tool return shapes vary — introspect, don't guess

MCP tools return different shapes: arrays, `{items: [...]}`, `{messages: [...]}`, `{data: {...}}`, `{data_preview: {...}}`, plain strings (XML, Markdown, or prose), and sometimes an empty string. Do NOT blindly write `result.items ?? result.messages ?? []` — if the real key is `entries` / `data.results` / `data_preview.messages`, that silently collapses to `[]` and every downstream step starves on empty data while the run still reports success.

**If you're the authoring agent: once you've decided which tool to call, run `introspect_tool_output({server, tool, args})` to get a real shape descriptor before writing unwrap code.** It invokes the tool live and returns a depth-limited descriptor (keys, types, array lengths, value samples) plus a redacted 1KB preview — never the full data. Refuses non-read-only tools unless `allowWrite: true`. Use realistic args (e.g. `{query: "is:unread", max_results: 3}`), then base the unwrap on what you got back. One probe call is much cheaper than shipping a jig that returns 0 results when the API returned 3.

**Composio tools cap inline responses at ~10k tokens.** Over that, the response spills to a sandbox file the MCP session can't reach and the wrapper throws `ComposioSpillError` at runtime. The bulkiest payloads come from Gmail (`messageText` is the full body, ~1-3k tokens each), Slack message history, GitHub file contents, and any tool with `verbose: true` / `include_payload: true`. **Default to small windows** — e.g. `max_results: 3-5` for any list/fetch on Composio — and paginate via `nextPageToken` if you need more. If `introspect_tool_output` returns `reason: "response_truncated"` or `warnings` mentioning sentinel strings, shrink your args before writing code; do not proceed against the truncated shape.

At each tool boundary:

1. Check `typeof result`.
2. If it's a **string** (Granola, some Apify tools, HTML scrapers), parse it — regex, `split`, `DOMParser`, or `llm()` to pull out the fields you need. Do not discard it.
3. If it's an **object**, unwrap with the documented key (`items`, `messages`, `meetings`, etc.), and fall back to surfacing the raw object — never to `[]`.
4. When uncertain, `ctx.output()` the first ~500 chars of the raw result so the real shape is visible in the run log.

Example — good:
```typescript
const raw = await granola.list_meetings({ time_range: "this_week" })
const text = typeof raw === "string" ? raw : JSON.stringify(raw)
const meetings = [...text.matchAll(/<meeting\s+id="([^"]+)"\s+title="([^"]+)"\s+date="([^"]+)"/g)]
  .map(([, id, title, date]) => ({ id, title, date }))
if (meetings.length === 0) {
  ctx.output(`No structured meetings parsed. Raw response head:\n\n\`\`\`\n${text.slice(0, 500)}\n\`\`\``)
  return
}
```

### 11. Format outbound messages nicely

When the jig sends content to a human — email bodies, Gmail, Telegram/Slack/Chat messages, any notification whose body is read by a person — format it for the destination channel, not as raw data:

- Lead with a clear title or heading.
- Short paragraphs; bullet lists where helpful.
- For Markdown channels, use bold for key names/numbers and `[label](url)` for links (never bare URLs).
- Never dump raw JSON, XML tool output, or uninterpreted IDs into the body. Summarize and reformat first — use `llm()` to rewrite the data into human-friendly prose when the tool returned an opaque shape.
- Gmail does not render Markdown in email bodies. If the user expects formatted Gmail output, generate valid HTML, send it in `body`, and set `isHtml: true`.
- Do not invent unsupported Gmail fields such as `contentType` or `htmlBody`; use the generated schema field `isHtml`.
- Do not wrap Markdown lines in HTML tags and call that "HTML". If the source is Markdown, either ask `llm()` for an HTML fragment with no Markdown markers, or deterministically convert inline Markdown (`**bold**`, `*italic*`, `[label](url)`) before sending.
- For branded Gmail output, use Gmail-safe inline styles or simple `<style>` rules with the Jig brand palette: dark canvas `#0a0a0b`, raised panel `#111113`, border `#1f1f23`, text `#ededed`, muted `#8b8b91`, emerald `#10b981`, blue `#60a5fa`, amber `#f59e0b`.
- The send step output should prove what changed: include the destination plus a short preview of sections/items rendered, not only "Email sent".
- For coaching, digests, and executive summaries, do not feed arbitrary newest Gmail messages into the LLM. Search with a bounded recent window, then filter out auth codes, noreply/notification senders, newsletters, prior jig alerts/failures, and other operational noise before summarizing.

Example — bad:
```typescript
await workspace.gmail_send({ to, subject, body: JSON.stringify(meetings) })
```

Example — good:
```typescript
const body = await llm(
  `Write a brief morning coach email from these meetings. Plain-text formatting: clear title, bullet list for key moments, short reflection paragraph.`,
  { meetings }
) as string
await workspace.gmail_send({ to, subject, body })
```

Example — good Gmail HTML:
```typescript
const htmlBody = await llm(
  `Write a brief morning coach email from these meetings as valid HTML. Use h2/h3 headings, ul/li lists, p tags, and strong tags. Return only the HTML fragment, not Markdown.`,
  { meetings }
) as string
await workspace.gmail_send({ to, subject, body: htmlBody, isHtml: true })
ctx.output(`Email sent to ${to}\n\nPreview:\n- Key insights: ${insightCount}\n- Questions: ${questionCount}`)
```

### 11b. Email the user a repliable message with `ctx.email()`

**Default:** when the user says "email me", "send me a digest", or wants a
daily/morning update **to themselves**, use `ctx.email()` — not Gmail/Composio.

When the jig's output is **for the user themselves** and they might want to act
on it — a daily digest, a morning briefing, a "here's what I found, reply to
adjust" report — send it with `ctx.email()` instead of an MCP email tool.
`ctx.email()` sends from Jig's own inbox, and **replying to it opens this jig's
authoring agent** (reply-to-edit): the user replies "also include X next time"
and the jig is edited. No MCP email connection needed.

```typescript
await ctx.step("Email the digest", [], async () => {
  const html = await llm(
    `Write today's reading digest as a valid HTML fragment (h2/h3, ul/li, p, strong). Return only HTML.`,
    { items },
  ) as string
  await ctx.email({ subject: `Daily digest — ${new Date().toLocaleDateString()}`, html })
  ctx.output(`Emailed the digest (${items.length} items). Reply to it to tweak this jig.`)
})
```

- Signature: `ctx.email({ subject: string; text?: string; html?: string }): Promise<{ threadId, messageId }>`. Pass `text`, `html`, or both.
- Always sends to the configured user (the AgentMail owner) — there is no `to`
  field, because reply-to-edit only works for replies from that address.
- Call it **inside a `ctx.step(...)`**, like any other send.
- **Use `ctx.email()`** when the recipient is the user and a reply should be able
  to change the jig. **Use `gmail_send`/MCP email tools** for one-way mail to
  *other* people (teammates, clients) — those aren't repliable-to-edit.
- It throws if AgentMail isn't set up, and is a no-op during dry-run.

### 12. Runtime performance guardrails

Slow jigs are usually caused by broad tool calls, too many detail reads, or
feeding oversized raw payloads into LLM steps. Bound every runtime path.

- Prefer narrow queries: include `timeMin`/`timeMax`, `maxResults`, label filters, or other schema-supported limits whenever available.
- Cap detail reads. Search broadly only to identify candidates, then read a small slice such as the top 5-10 relevant items.
- Use `ctx.parallel()` for independent reads only after capping the list. Do not launch unbounded parallel tool calls.
- Convert raw tool responses into compact records before calling `llm()`: title, date, sender, short excerpt, URL/ID if needed. Do not send full email bodies, full transcripts, XML dumps, or huge JSON unless the task requires it.
- Prefer deterministic filtering for obvious rules. Use `llm()` once over a compact list for fuzzy classification; do not call `llm()` once per calendar event/email/meeting.
- If a step gathers many items, `ctx.output()` a preview of the exact capped set that will feed later steps so slow or noisy inputs are visible in the run log.
- For recurring jigs, avoid reprocessing the entire account history on every run. Use a recent window or compare against the last run when available.
- **Cron jigs that alert ahead of upcoming events must match each event to exactly ONE tick.** Jigs have no cross-run state, so a lookahead window wider than the cron period re-matches the same event on every tick until it starts (every-15-min cron + "next hour" window = up to 4 duplicate alerts per event). Align the window to one cron bucket instead: with period P and lead time L, select only events starting between `now + L - P` and `now + L` (e.g. 15-min cron, 1h lead → events starting 45-60 min from now). Also exclude events that already started.

Bad:
```typescript
const events = await workspace.calendar_listEvents({ calendarId: "primary" })
for (const event of events) {
  classifications.push(await llm("Classify this event", { event }))
}
```

Good:
```typescript
const events = await workspace.calendar_listEvents({
  calendarId: "primary",
  timeMin: weekStart.toISOString(),
  timeMax: weekEnd.toISOString(),
})
const compactEvents = (Array.isArray(events) ? events : (events as any).items ?? [])
  .filter((event: any) => event.summary && event.start?.dateTime)
  .slice(0, 20)
  .map((event: any) => ({
    title: event.summary,
    start: event.start.dateTime,
  }))
const classification = await llm("Classify these events as professional or personal", { events: compactEvents })
```

### 13. Code format
- Output ONLY TypeScript code. No explanation, no markdown fences.
- Import SDK: `import { jig, llm, agent } from "@jig/sdk"`
- Import connections: `import { serverName } from "@jig/connections/serverName.js"`
- Use exact param names and types from the type definitions and schemas
- For Jig-specific behavior, prompts, validators, schemas, or generated code, use this repo as the source of truth. Do NOT browse or web-search for Jig docs or Jig behavior.
- Use `ctx.output()` inside `ctx.step()` blocks for output, NEVER `console.log()`
- ALL tool calls MUST be inside `ctx.step()` blocks — tools called outside a step throw at runtime
- Remove unused imports and unused entries from the `tools` array. If you imported `agent` but never call it, or declared `composio.gmail_fetch_message_by_message_id` in `tools` but never call it, delete it before finishing.
- End the file with: `export default myJig`
- Do NOT call `run()` or `process.exit()`
- Do NOT use `require()` or CommonJS imports
- Do NOT use relative imports (`../`) — always use the `"@jig/sdk"` and `"@jig/connections/"` aliases
- Do NOT add markdown fences around the code

### 14. Silent on empty by default
If a jig fetches data and gets nothing back, do NOT send an "empty digest" / "nothing found" notification unless the user explicitly asked for empty-state pings. Default behavior: `ctx.output()` that nothing was found, then return. The user does not need a daily "no emails today" email — that's noise.

Bad:
```typescript
if (emails.length === 0) {
  await gmail_send_email({ to, subject: "No emails today", body: "Nothing to report." })
  return
}
```

Good:
```typescript
if (emails.length === 0) {
  ctx.output(`No matching emails in the past ${DAYS_BACK} days. Nothing to send.`)
  return
}
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

### Runtime payloads

Do not declare jig params. When a trigger naturally carries runtime data, read it from `ctx.params`.

- Webhook payloads arrive as nested JSON on `ctx.params`
- Manual runs may also pass runtime payloads externally
- If a value is really a constant, ask once and hardcode it instead of reading it from `ctx.params`

Good:

```typescript
const myJig = jig("weekly-update", {
  tools: [granola.list_meetings],
}, async (ctx) => {
  const meetings = await granola.list_meetings({ time_range: "last_week" })
})
```

Also good:

```typescript
const myJig = jig("telegram-message", {
  trigger: { type: "webhook" },
  tools: [workspace.gmail_search],
}, async (ctx) => {
  const message = (ctx.params.message as any)?.text ?? ""
  const emails = await workspace.gmail_search({ query: message })
})
```

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
// Don't do this — don't turn inferred constants into runtime payloads or config
const recipient = (ctx.params as any).recipient
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

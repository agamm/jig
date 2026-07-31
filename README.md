# Jig

**Trusted AI workflows as code.**

Describe a workflow in plain English. Jig turns it into versioned TypeScript you can review, run, and schedule.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/jig?utm_medium=integration&utm_source=button&utm_campaign=jig)

## Why Jig

A carpenter's jig is set once for repeatable results. Jig applies that idea to AI workflows: AI writes the workflow, then code runs it predictably.

Use plain code for repeatable work, `llm()` for bounded generation, and `agent()` only when runtime judgment is useful.

```text
Most agents:  LLM -> LLM -> LLM -> LLM -> result
              Every run depends on the model at every step.

Jig:          code -> code -> [AI] -> code -> result
              Code runs the workflow. AI is used deliberately.
```

## Architecture

Jig separates authoring from execution: the authoring agent writes a versioned TypeScript `JigDefinition`; the runtime imports the approved version; and the SDK enforces step, model, and typed MCP tool boundaries.

![Jig technical architecture: authoring and execution planes connected through a versioned store, runtime engine, SDK, typed MCP connections, and model API](docs/jig-architecture.svg)

## Ideas for Your First Jig

* **Reasons to reach out.** Watch LinkedIn, news, and reminders for moments worth celebrating.
* **Post-meeting follow-up.** Turn notes and email threads into a thoughtful follow-up.
* **Reconnect radar.** Suggest people worth reconnecting with and explain why now.

## Example

> Every Monday at 8am, email me a concise update from last week's client meetings.

```typescript
import { jig, llm } from "@jig/sdk"
import { granola } from "@jig/connections/granola.js"

export default jig("weekly-client-update", {
  trigger: { type: "cron", cron: "0 8 * * 1" },
  tools: [granola.list_meetings],
}, async (ctx) => {
  let meetings: unknown

  await ctx.step("Gather meetings", [granola.list_meetings], async () => {
    meetings = await granola.list_meetings({ time_range: "last_week" })
    ctx.output(JSON.stringify(meetings, null, 2))
  })

  await ctx.step("Email update", [], async () => {
    const text = await llm("Write a concise client update.", { meetings }) as string
    await ctx.email({ subject: "Weekly client update", text })
    ctx.output(text)
  })
})
```

`ctx.step()` scopes each operation. `ctx.email()` sends a repliable notification to the configured owner; it does not create a Gmail draft.

## What You Get

* Versioned TypeScript workflows with reviewable changes
* Step-scoped tools and deliberate `llm()` / `agent()` boundaries
* MCP, Composio, Apify, and custom connections
* Local runs or always-on Railway deployment

## Usage

The Railway button creates a fresh service with a blank persistent `/data` volume and no maintainer data, credentials, OAuth state, variables, logs, or personal configuration.

```Shell
# Or run locally
git clone https://github.com/agamm/jig.git
cd jig
bun install
bun run jig start
```

Open the dashboard, connect the services you want, and tell Jig what to build.

* connect Gmail, Calendar, GitHub, Apify, or other services
* describe the workflow in plain English
* review the generated jig as code
* run it manually or leave it scheduled

On first run, Jig installs the dashboard dependencies. Runtime state belongs in the ignored local database or Railway `/data` volume; do not commit credentials or instance data.

## Connections

Jig can connect workflows to external tools and data sources. The default registry in this repo includes:

* `granola`: meeting notes and transcripts
* `notion`, `linear`, `figma`, `sentry`, and other direct MCP services
* `apify`: typed tools for public-web scraping and extraction
* `composio`: Gmail, Calendar, GitHub, Slack, Telegram, and a long tail of SaaS apps

List available services with:

```Shell
bun run jig connect
```

Connect one with:

```Shell
bun run jig connect <service>
```

## How A Jig Is Structured

Each jig is a TypeScript file that exports `jig(name, options, handler)`.

* `trigger` decides when it runs: `manual`, `cron`, or `webhook`
* `tools` declares the tools the jig may use
* `ctx.step(...)` creates explicit execution steps
* `llm(...)` is for bounded generation without tool use
* `agent(...)` is for bounded agent behavior with a specific tool set

Generated jigs use these import aliases:

* `@jig/sdk`
* `@jig/connections/<service>`

## Project Layout

* `jig.db*`: ignored local state and the authoritative versioned jig store
* `.jig/connections/`: generated typed connection clients
* `.jig/schemas/`: cached tool schemas
* `examples/`: example jigs
* `dashboard/`: local UI for authoring and runs
* `src/`: runtime, CLI, scheduler, and code generation internals

## Coding Agents

Start with [`llms.txt`](llms.txt). Claude Code and other repository-aware agents should also read [`AGENTS.md`](AGENTS.md); jig authors should follow [`SKILL.md`](SKILL.md), and deployment or recovery work should follow [`docs/operations.md`](docs/operations.md).

## CLI Commands

```Shell
bun run jig start
bun run jig connect
bun run jig connect composio
bun run jig new "Every Friday at 4pm, draft a weekly update email from my meetings and emails."
bun run jig edit weekly-update
bun run jig run weekly-update
bun run jig run weekly-update --dry-run
```

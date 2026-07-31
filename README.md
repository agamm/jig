# Jig

**AI agents you can actually trust. AI Workflows as Code.**

AI agent that can automate your personal life or business operations while keeping things in check.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/jig?utm_medium=integration&utm_source=button&utm_campaign=jig)

## Why Jig

A jig, in a carpenter's workshop, is a fixture you set up once so every cut after it is identical. You trust it. It does not surprise you.

Most AI automation today is the opposite. It is an agent with broad tool access and a prompt full of rules you hope it keeps following. That works until a vague request turns into an expensive mistake.

For decades, the world has run on code. Planes fly on it. Banks clear trillions on it. Power grids balance on it. You would not send a rocket on LLM vibes.

In 2025 the default answer for every new workflow became: let an agent figure it out fresh each time.

But most work is not novel. The invoice goes out on the 1st. The update goes out Monday. The triage missed emails happens every morning. These workflows do not need an LLM routing them from scratch on every run. They need reliability by repeatability.

What is good at repeatability? Code. What AI is great at? Writing code.

This is the obvious move nobody made. Terraform to SSH is what Jig is for AI agents. Let AI write the workflow. Let code run it. Call the model back only where code cannot: drafting an email in your voice, deciding which meetings mattered, or reading a messy PDF.

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

* **Reasons to reach out.** Watch LinkedIn updates, news, and personal reminders for moments worth celebrating, then surface the person and the context.
* **Post-meeting follow-up.** Turn meeting notes and related email threads into a thoughtful follow-up draft while the conversation is still fresh.
* **Reconnect radar.** Find people you have not spoken with lately, suggest who is worth reconnecting with, and explain why now.

## A Jig, Written From One Sentence

From a sentence like:

> Every Monday at 8am, email me a client update from last week's meetings and emails.

Jig can generate something like:

```TypeScript
trigger: { type: "cron", cron: "0 8 * * 1" }

// ...

const meetings = await workspace.calendar_listEvents({ calendarId: "primary" })
const emails = await workspace.gmail_search({ query: "from:client newer_than:7d" })

// ...

const body = await llm("Write a short client update", { meetings, emails })
await workspace.gmail_createDraft({ to: "client@acme.co", subject: "Weekly update", body })
```

Written by AI from one sentence. At runtime, only `llm(...)` calls the model back. The rest is code.&#x20;

## What You Get

* Determinism as a superpower. Every run flows the same. AI powerups only where you need them.
* AI you can actually trust. Dependable workflows that work 24/7.
* Scoped tools per step. Know exactly what can run, and when.
* Connects to everything. MCP, Composio, Apify.
* Open source. Fork it. Extend it. Write your own connections.
* Local or cloud. Run it on your laptop or deploy it for always-on workflows.

## Usage

For an always-on instance, use the Deploy on Railway button above. It creates a
fresh service with a blank persistent `/data` volume. The template includes no
maintainer database, credentials, OAuth state, variables, logs, or personal
configuration.

```Shell
# Or run locally
git clone https://github.com/agamm/jig.git
cd jig
bun install
bun run jig start
```

Open the dashboard, connect the services you want, and tell Jig what to build.

The intended flow is dashboard-first:

* connect Gmail, Calendar, GitHub, Apify, or other services
* describe the workflow in plain English
* review the generated jig as code
* run it manually or leave it scheduled

On first run, Jig installs the dashboard dependencies automatically. Runtime
state belongs in the ignored local database or the Railway `/data` volume; do
not commit credentials or instance data to Git.

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
* `jigs/`: legacy workflow import source
* `.jig/connections/`: generated typed connection clients
* `.jig/schemas/`: cached tool schemas
* `examples/`: example jigs
* `dashboard/`: local UI for authoring and runs
* `src/`: runtime, CLI, scheduler, and code generation internals

## Current State

This repo supports local development and a one-click Railway deployment. External
services still have provider-specific authentication and availability
constraints; connect only the tools each workflow needs.

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

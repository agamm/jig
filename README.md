# Jig

**AI agents you can actually trust. AI Workflows as Code.**

AI agent that can automate your personal life or business operations while keeping things in check.

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

```
bunx jig start
```

```Shell
# Or
git clone <repo-url>
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

On first run, Jig will install the dashboard dependencies automatically. Commit and push to github to backup or share your setup.

## Connections

Jig can connect workflows to external tools and data sources. The default registry in this repo includes:

* `workspace`: Gmail, Calendar, Drive, Docs, Sheets, Chat
* `granola`: meeting notes and transcripts
* `github`: repositories, pull requests, issues, commits
* `apify`: typed tools for public-web scraping and extraction
* `composio`: Slack, Telegram, and a long tail of SaaS apps

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

* `jigs/`: your generated workflows
* `.jig/connections/`: generated typed connection clients
* `.jig/schemas/`: cached tool schemas
* `examples/`: example jigs
* `dashboard/`: local UI for authoring and runs
* `src/`: runtime, CLI, scheduler, and code generation internals

## Current State

This repo is already usable for local workflow automation, but the install flow is still developer-oriented rather than productized. Expect the local-first path to be the best-supported one for now.

## CLI Commands

```Shell
bun run jig start
bun run jig connect
bun run jig connect workspace
bun run jig new "Every Friday at 4pm, draft a weekly update email from my meetings and emails."
bun run jig edit weekly-update
bun run jig run weekly-update
bun run jig run weekly-update --dry-run
```

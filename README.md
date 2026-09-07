# Jig

**Trusted AI workflows as code.** Your coding agent writes the workflow in TypeScript. Jig runs it on a schedule, on a server you own, with the AI parts kept small and explicit.

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/new/template/jig?utm_medium=integration&utm_source=button&utm_campaign=jig)

## Five reasons to use Jig

1. **Code runs the workflow, AI is used on purpose.** Most agent tools call a model at every step, so every run depends on the model's mood. A jig is plain code with `llm()` where you need text and `agent()` only where you need judgment. Same input, same path, every run.
2. **Your coding agent is the author.** Claude Code or Codex writes the jig against typed tool clients, pushes it, and it lands as a pending version. Nothing runs until you approve it. You review a diff, not a chat log.
3. **Always on, without babysitting.** One command deploys to Railway. Credentials are encrypted with your password, the instance unlocks itself after a restart, and your jigs, versions and run history live on a volume that survives deploys.
4. **Failures explain themselves.** A failed run emails you the step, the error, the likely cause (expired authorization, rate limit, the jig's own code) and the exact next command, plus a prompt your agent can paste as-is. Reply to the email to have the jig edited.
5. **Secure by default.** Browser authorization instead of pasted keys, tools scoped per step, dry runs that stub every write, and an approval gate on every code change. The defaults are the safe ones; you opt out, never in.

## A warning, honestly

Jig is alpha and very much vibe coded: most of it was written with coding agents, quickly. What keeps that honest is the architecture rather than the polish. The surface is small, every risky action sits behind a gate (approval, read-only checks, an encrypted credential store), and the defaults are the secure ones. Expect rough edges in the dashboard and the docs. Do not expect your credentials or your jigs to be at risk from those edges.

## How it works

```text
Most agents:  LLM -> LLM -> LLM -> LLM -> result     every step depends on the model
Jig:          code -> code -> [AI] -> code -> result   code runs it, AI is a deliberate step
```

Authoring and execution are separate. A coding agent writes a versioned TypeScript jig and pushes it over the CLI. The runtime imports only the approved version. The SDK enforces the step, model and typed-tool boundaries the jig declares.

![Jig architecture: authoring and execution planes joined by a versioned store, runtime, SDK, typed MCP connections and the model API](docs/jig-architecture.svg)

A jig looks like this:

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

Each `ctx.step()` names what it does and which tools it may call; a step cannot reach a tool it did not declare. `ctx.email()` sends a repliable message to you, the owner. Connections cover direct MCP servers (Granola, Notion, Linear and more), Composio (Gmail, Calendar, Slack, Telegram and a long tail) and Apify. The full authoring guide is [`SKILL.md`](SKILL.md).

## The workflow: coding agent to Railway

**1. Let the agent install and deploy.** Paste this into Claude Code or Codex:

```text
Install and set up Jig from https://github.com/agamm/jig.git. Clone it, read
.agents/skills/jig/SKILL.md in the clone, and follow it. Ask me the questions it says to
ask before you start anything. Setup opens links for me to authorize; wait for me rather
than answering for me. When it is done, give me the dashboard URL, tell me which steps
came back ready, and give me the pairing command for my own checkout.
```

The agent asks two questions first (hosted or local, and which Railway account), then runs `jig deploy` and `jig setup`. You claim the new instance with the one-time code from its logs and choose a password. Setup then opens the browser for OpenRouter (model access), walks you through creating an AgentMail key (alerts and reply-to-edit), and optionally Composio. Each step is proven, not assumed: OpenRouter has to answer with credit, AgentMail has to deliver a real mail to you.

Without an agent: `git clone`, `bun install`, `bun run jig setup`. The Railway button above does the deploy part on its own; the dashboard's Setup page walks the rest.

**2. Pair your checkout.** Setup ends with a single-use pairing command. Run it in the checkout you write jigs from, and every later `jig` command there talks to your instance.

**3. Write jigs with the agent.** The dashboard's Setup page has a first-jig prompt. From then on the loop is:

```shell
bun run jig types                                        # the instance's connection types, into .jig/connections/
bun run jig edit weekly-update --file=weekly-update.ts   # push code (creates the jig if new; typechecked, pending)
bun run jig run weekly-update --dry-run                  # preview the pending version, writes stubbed
bun run jig pending weekly-update approve
bun run jig run weekly-update
```

**4. When something fails.** You get an email with the cause and the fix. Your agent starts from the same place:

```shell
bun run jig debug failures      # every failed run of the last week, classified, with the remedy
bun run jig debug audit         # what is failing now, since when, and the next command
```

**5. Keep it current.** `bun run jig update` pulls this checkout and the agent skills; `bun run jig update <handle>` moves the instance to the newest release with a health check and rollback. A template-button instance updates by redeploying in Railway. `bun run jig backup` writes a zip of the instance's jigs, connections and settings.

## Security

What protects your accounts, in order of what matters most:

| Layer | What it does |
|---|---|
| Password and encryption | Your password never leaves your browser or terminal and is never stored. It derives a key (PBKDF2, 600k rounds) that encrypts every credential at rest with AES-256-GCM. |
| Restart-proof unlock | `jig deploy` and the Railway template give the service a random `JIG_DATA_KEY`. The data key is stored wrapped under it, so a restart unlocks itself. The variable lives only on the service: not on the volume, not in backups, not in the CLI manifest. A stolen volume alone reveals nothing. |
| Claiming an instance | A new instance prints a one-time setup code to its logs. Only someone who can read those logs can set the first password, so nobody can claim your instance before you do. |
| Browser authorization | OpenRouter, Composio and MCP servers authorize in your browser with OAuth. Keys are delivered to the instance, never shown to the agent. The one exception, AgentMail, is pasted into the dashboard, not into a chat. |
| Approval gate | A code change from an agent or a CLI push lands as a pending version, typechecked and validated on arrival, and waits for you (or a clean push with `--approve`). An email reply from you is the approval: the edit ships once it passes the same check, and only replies that carry the thread's secret token count. |
| Scoped steps | A step can only call the tools it declares. Dry runs stub every write. A write that hits a gateway error is repeated at most once, never after a timeout, so a blip does not mean a duplicate email. |
| Reply-to-edit | An email reply edits a jig only when it comes from your address, passes AgentMail's signature and authentication checks, and carries the thread's secret token. |
| Small surface | The API binds to loopback; the dashboard is its only client, behind a signed session cookie. The published image is built by GitHub Actions from an allowlisted subset of this public repo, and the template ships no maintainer data. |

Backups carry credentials as ciphertext and nothing instance-local (no session secret, no key wrap). Restoring onto an instance with a different password asks for the backup's password and re-encrypts under the instance's own; it never replaces that password. Details for operators are in [`docs/operations.md`](docs/operations.md).

## For coding agents

* Running an instance (install, setup, connect, deploy, update): [`.agents/skills/jig/SKILL.md`](.agents/skills/jig/SKILL.md), the cross-agent skills directory Claude Code, Codex, Cursor and OpenCode read.
* Writing workflow code: [`SKILL.md`](SKILL.md), read completely before editing a jig.
* Everything else: [`llms.txt`](llms.txt) routes the task, [`AGENTS.md`](AGENTS.md) is the cross-agent entry point.

`edit`, `run`, `pending`, `types` and `backup` act on your deployed instance when you have one and say which one before starting. `--local` means this machine, `--handle=<name>` picks between instances. `bun run jig` lists every command.

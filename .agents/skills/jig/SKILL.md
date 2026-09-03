---
name: jig
description: Install, set up, connect, deploy and update a Jig instance. Use when the user wants to get Jig running, onboard it (OpenRouter, AgentMail, Composio), host it on Railway, or update an existing install. For writing or editing workflow code, read SKILL.md in the repo root instead.
---

# Operating Jig

Jig turns plain-English requests into versioned TypeScript workflows. This skill covers
running an instance. It does not cover authoring jigs: for that, read `SKILL.md` in the
repo root, completely, before touching workflow code.

## Ground rules

- **Never hand-edit files under `jigs/`.** They are the authoring pipeline's output. Use the
  dashboard or `bun run jig new|edit`.
- **Never commit runtime state**: `.env`, `.jig/`, `jig.db*`, `jig.log`, `runtime/`, `tmp/`.
- **Never ask the user for an API key you could get from a browser authorization.** Setup is
  built so nobody types a secret at you.

## Ask before you start

Setup makes two decisions that are the user's, not yours, and both are awkward to undo. Ask
them **before running anything** rather than discovering them mid-flow. In Claude Code that is
the AskUserQuestion tool; otherwise just ask in the conversation and wait.

1. **Hosted or local?** Recommend hosted. A jig that only runs while their machine is on is not
   automation. Local is right for trying it out or developing Jig itself.
2. **If hosted, which Railway account or team?** `jig deploy` uses whichever scope the Railway
   CLI is currently logged into and never asks. Deploying one client's work into another's
   account is not a thing you can quietly fix afterwards, so confirm the scope out loud even
   when the CLI is already authenticated.

Then run setup non-interactively with the answer baked in: `--railway` or `--local`. You have no
TTY, so setup cannot ask you, and it refuses rather than guessing.

Everything after that point is a browser authorization the user completes themselves. Print the
link, wait, and do not answer on their behalf.

## Install

Jig is meant to run hosted. A jig that only runs while a laptop is open is not automation, so
the default is a Railway instance and local is the deliberate alternative.

```sh
git clone https://github.com/agamm/jig.git
cd jig
bun install
bun run jig setup          # asks hosted-or-local, defaults to hosted
```

With no instance yet, `jig setup` offers to provision one on Railway and then sets that one up.
At a terminal it asks; with the answers you gathered above, pass `--railway` or `--local` and it
skips the question. With no terminal and no flag it refuses rather than quietly standing up a
local server, because a local instance is not what most people wanted and it looks like success.

For a local instance:

```sh
bun run jig setup --local
bun run jig start
```

**Running this as an agent against a local instance, start the dashboard first**, because the
no-terminal path for AgentMail collects its key there:

```sh
bun run jig start &        # wait for the dashboard to answer
bun run jig setup --local --yes
```

`jig start` runs the Next dashboard (3141) and the Bun API behind it. First run installs the
dashboard's deps with pnpm, not bun. A hosted instance serves both from its public URL and
needs no `jig start`.

## Setup and onboarding

`bun run jig setup` walks three steps and verifies each one instead of assuming it:

| Step | How it completes | Required |
|---|---|---|
| OpenRouter | Browser authorization (OAuth PKCE). The key is delivered to the instance; nobody sees it. Passes only when the credit balance reads back, because a valid key with zero credit fails every model call. | yes |
| AgentMail | The one step with no authorization server. Setup opens `console.agentmail.to`, names the clicks, and takes the key. Proven by sending real mail to the owner address. | yes |
| Composio | Browser authorization. One consent covers Gmail, Calendar, Slack, Telegram and a long tail. | no |

**Running it as an agent (no TTY):** nothing is asked of you. Authorization URLs are printed
for the human to click and setup polls until they land. AgentMail is collected in the
dashboard, which setup opens and waits on, so **the dashboard must be running** for that step
(`jig start` first). Wait for setup rather than answering on the user's behalf.

Escape hatch for a machine with no browser at all: `--openrouter-key=`, `--agentmail-key=`,
`--owner=` (or `JIG_OPENROUTER_KEY`, `JIG_AGENTMAIL_KEY`, `JIG_OWNER_EMAIL`) pre-seed those
values, and the matching step then finds itself already satisfied. Prefer the browser.

Re-running setup is safe. Satisfied steps report as done and are skipped.

The dashboard has the same thing at **Setup** in the sidebar, running the same flow: a card per
step with its live status, a button per card so one thing can be fixed without re-walking the
others, and a panel showing where the instance runs and whether `/data` survives a restart.
Point a human there; use the CLI when you are driving.

## Connect services

```sh
bun run jig connect              # list what is available
bun run jig connect <service>    # authorize one
```

Connections authorize in a browser and land in the encrypted credentials table. There are no
`client_id` / `client_secret` / PAT fields anywhere; if a service needs a token from another
tool, it uses an `auth` command in the registry instead.

## Deploy to Railway

Two supported paths.

**Template button** (in the README): provisions a service from `ghcr.io/agamm/jig:latest`
plus a blank `/data` volume. No clone, no CLI. `.github/workflows/publish-container.yml`
republishes that image on every push to `main`.

**From a clone**, which is what `jig setup` runs for you when you accept the hosted default:

```sh
bun run jig deploy
```

It authenticates the Railway CLI, creates and links the project and service, mounts a volume
at `/data`, deploys, generates a domain, waits for `/api/health`, and writes a manifest to
`~/.config/jig/remotes/`. That manifest is what later lets `jig update` find the instance.

**Ask which Railway account or team to deploy under before running it.** Being logged in is
not consent to use whatever scope is active.

`/data` is the whole instance: credentials, jigs, schedules, runs. A deployment without a
volume loses everything on restart.

## Update

Pick by how it was installed.

```sh
# A local clone
git pull && bun install

# A Railway instance deployed from this clone
bun run jig update [handle]

# The exact working tree instead of a release tag
bun run jig deploy --update
```

`jig update` deploys the newest **semver tag** on origin, waits for `/api/health` to report
the new version, and rolls back to the previous commit if the deploy fails. It compares
versions numerically and refuses to move an instance onto an older tag, because old code
against a volume whose migrations already ran is data damage, not a failed update.

Consequences worth stating to the user rather than working around:

- If `main` is ahead of the newest tag, `jig update` correctly refuses. Tag the release
  first: `git tag v0.2.0 && git push origin v0.2.0`.
- A **template-button instance has no clone and no manifest**, so `jig update` cannot reach
  it. Update it by redeploying the service in Railway, which re-pulls the image.

Jigs, credentials and schedules live in the database (`/data` hosted, `jig.db` local), never
in the source tree, so updating code does not touch them.

## When something is wrong

Read `docs/operations.md` for health triage, repairing a failing jig, and the built-in
self-healing loop. Two fast signals:

- `bun run jig doctor` for instance health.
- `"SSE error: Non-200 (405)"` means an outbound MCP connection failed to authorize
  (usually expired auth), not a dashboard problem.

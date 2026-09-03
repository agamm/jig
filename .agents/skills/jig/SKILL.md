---
name: jig
description: Install, set up, connect, deploy and update a Jig instance. Use when the user wants to get Jig running, onboard it (OpenRouter, AgentMail, Composio), host it on Railway, or update an existing install. For writing or editing workflow code, read SKILL.md in the repo root instead.
---

# Operating Jig

Jig turns plain-English requests into versioned TypeScript workflows. There are two skills and
the split matters:

- **This one** is how you operate an instance: install it, set it up, connect services, deploy
  it, update it, and get a jig authored, approved and run.
- **`SKILL.md` in the repo root** is how you WRITE the workflow code itself: the SDK, `ctx.step`,
  `llm()` versus `agent()`, tool scoping. Read it completely before writing or editing a jig.

Reach for that one when you are producing TypeScript, this one for everything else.

## Ground rules

- **Never hand-edit files under `jigs/`.** They are the authoring pipeline's output. Use the
  dashboard or `bun run jig new|edit`.
- **Never commit runtime state**: `.env`, `.jig/`, `jig.db*`, `jig.log`, `runtime/`, `tmp/`.
- **Never ask the user for an API key you could get from a browser authorization.** Setup is
  built so nobody types a secret at you.
- **Never automate the dashboard in a browser.** Everything it does has a CLI path; driving it
  with browser tools lands you on a login screen you cannot pass, and wastes the user's time.
- **Probe before you state.** Never report what is connected, what tools exist, or what a tool
  returns from inference, from a file on disk, or from what was true earlier in the session. Run
  the command that answers it, then say what came back. "Connected" in particular is layered:
  a connection can be authorized while the apps inside it are not, so name which layer you
  checked and how. If you catch yourself writing "X is not connected" without having just asked
  the instance, stop and ask it.

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

### Connecting the CLI to a hosted instance

`jig setup` signs itself in when it needs to, prompting for the instance password or reading
`JIG_PASSWORD`. You have neither, and a password must not pass through a chat.

Ask the user to open the dashboard's **Setup** page, press **Generate command** under "Connect
the CLI", and paste you the line it produces:

```sh
bunx --bun github:agamm/jig pair <code> --url=https://<their-instance>
```

`bunx` on purpose: it runs from any directory and needs no checkout, so you can paste it
wherever you happen to be. The first run fetches the CLI and takes a moment.

The code is single use and expires in ten minutes, which is what makes it safe to paste. Running
it caches a 30-day session in `~/.config/jig/remotes/`, and every later `jig setup`, `jig update`
and `jig debug` command against that instance works without asking again.

**One trap worth knowing for the other commands.** `bun run jig …` needs the clone as your
working directory. One directory above it, `bun run jig` matches the `jig` FOLDER rather than the
package script and exits 0 having printed nothing. Any `bun run jig` command that produces no
output at all means exactly that: check `pwd` before believing the command is broken.

## Create and run a jig

Coding agents are the main way jigs get written, so this is a first-class CLI path, not a
fallback. Writing the workflow code itself is a different skill: read `SKILL.md` in the repo
root, completely, before you write or edit any jig.

```sh
bun run jig new "email me a random number, once"
bun run jig pending <jig-id>            # read the diff it proposes
bun run jig pending <jig-id> approve    # or: discard
bun run jig run <jig-id> --dry-run      # prove it without side effects
bun run jig run <jig-id>                # trigger it once for real
```

**`jig new` authors on the instance you deployed**, not on this machine. It resolves the active
remote from `~/.config/jig/remotes/` and posts to its authoring agent over the paired session,
and it prints which instance it chose before it starts. Add `--local` when you mean this
machine, or `--handle=<name>` to pick between several instances.

If the remote has no cached session it refuses rather than quietly authoring locally, because
a jig on the wrong instance is a mistake you notice much later. Pair it first: see "Connecting
the CLI to a hosted instance" above.

Once a jig exists on a remote, the rest of the loop is `jig debug`:

```sh
bun run jig debug ls                          # what is on the remote
bun run jig debug pull <jig-id> --out=jig.ts  # its live code
bun run jig debug push <jig-id> jig.ts        # upload as PENDING
bun run jig debug push <jig-id> jig.ts --approve   # skip the review gate
bun run jig debug run <jig-id>                # trigger once, stream the logs
bun run jig debug tail                        # keep watching
```

`pull` → edit → `push` → `run` → `tail` is the supported loop for changing a deployed jig from
your own editor. `push` leaves the change pending on purpose, the same human gate the dashboard
and auto-repair use; `--approve` opts out of it.

**Never drive the dashboard through a browser.** If you find yourself opening Chrome to click
"New Jig", stop: you cannot authenticate that tab, the password is not yours to type, and every
button there has a CLI equivalent above. A missing capability is something to report, not
something to automate around.

**Never hand-edit files under `jigs/`.** SQLite is the source of truth; a hand edit is
overwritten by the next write and skips version history entirely.

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

```sh
bun run jig update            # latest code AND agent skills from GitHub
bun run jig update --remote   # ...then redeploy your instance with it
```

`jig update` pulls this checkout forward (stashing local changes and restoring them after) and
reinstalls dashboard deps. **If it reports that `.agents/skills` changed, re-read this file
before continuing**: the instructions you are following may have just moved.

`--remote` deploys what you have just pulled, rather than the newest release tag, because tags
lag `main` and the point of the flag is to ship the code in front of you. Redeploying is opt-in
on purpose: it restarts someone's running automation, which should never be a side effect of
updating a checkout.

For the tag-based flow with health-check rollback, use the handle form:

```sh
bun run jig update <handle>   # deploy the newest semver tag, roll back if it fails
```

It compares versions numerically and refuses to move an instance onto an older tag, since old
code against a volume whose migrations already ran is data damage rather than a failed update.
If `main` is ahead of the newest tag it correctly refuses; tag the release first
(`git tag v0.2.0 && git push origin v0.2.0`).

Other ways in:

- **A local clone with no instance:** `git pull && bun install` is what `jig update` does.
- **A Railway instance from the template button:** no clone and no manifest, so `jig update`
  cannot reach it. Redeploy the service in Railway, which re-pulls the published image.

Jigs, credentials and schedules live in the database (`/data` hosted, `jig.db` local), never in
the source tree, so updating code does not touch them.

## When something is wrong

Read `docs/operations.md` for health triage, repairing a failing jig, and the built-in
self-healing loop. Two fast signals:

- `bun run jig doctor` for instance health.
- `"SSE error: Non-200 (405)"` means an outbound MCP connection failed to authorize
  (usually expired auth), not a dashboard problem.

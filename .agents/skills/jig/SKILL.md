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

- **Never hand-edit files under `jigs/`.** SQLite is the source of truth. Write the jig file in
  your checkout and push it with `bun run jig edit <id> --file=`.
- **Never commit runtime state**: `.env`, `.jig/`, `jig.db*`, `jig.log`, `runtime/`, `tmp/`.
- **Never ask the user for an API key you could get from a browser authorization.** Setup is
  built so nobody types a secret at you.
- **Never automate the dashboard in a browser.** Everything it does has a CLI path; driving it
  with browser tools lands you on a login screen you cannot pass, and wastes the user's time.
- **Read the failure log before any jig work.** `bun run jig debug failures` lists every failed
  run of the last seven days with its cause and the exact remedy. Offer those remedies before
  editing code: an expired authorization, a Composio result that spilled past the inline limit,
  or a provider outage is not a code bug, and a jig edited for one of those fails the same way
  next run. `--jig=<id>` narrows it, `--json` is the raw log.
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

Then run setup non-interactively with the answers baked in: `--railway --yes` (add
`--workspace=<name>` when they named a team or workspace) or `--local --yes`. You have no TTY,
so setup cannot ask you, and it refuses rather than guessing. `--yes` also answers the deploy's
own confirmations; anything destructive (deleting an existing project) still answers no.

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
bun run jig start
```

Finish the steps on the dashboard's **Setup** page. To drive the same flow from the CLI, leave
`jig start` running and use a second terminal:

```sh
bun run jig setup --local --yes
```

**Running this as an agent against a local instance, always start the dashboard first**, because
the no-terminal path for AgentMail collects its key there.

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

**Restart-proof unlock.** A hosted instance needs a `JIG_DATA_KEY` service variable, or every
redeploy and restart pauses its jigs until the owner types the password. `jig deploy` and the
Railway template set it; `jig setup` and `jig update <handle>` add it to an older instance when
this machine deployed it (the manifest holds the Railway ids). When setup prints that it cannot
(the instance was paired from elsewhere, or came from the template before the variable
existed), relay the steps it prints to the user: in Railway open the service, then Variables,
add `JIG_DATA_KEY` with 64 random hex characters. The next restart asks for the password once,
then never again. `jig doctor` reports it as `restart_safe`, and the dashboard's Setup page
shows a notice while it is missing. Never generate, print or paste the value yourself.

The dashboard has the same thing on its **Setup** page (the first thing a new instance shows;
afterwards under **Settings → Setup**), running the same flow: a card per
step with its live status, a button per card so one thing can be fixed without re-walking the
others, and a panel showing where the instance runs and whether `/data` survives a restart.
Point a human there; use the CLI when you are driving.

### Connecting the CLI to a hosted instance

`jig setup` signs itself in when it needs to. The machine that ran `jig deploy` holds the
instance's first-boot setup code, so on that machine nothing is pasted: setup prints the
dashboard URL and the code, waits for the user to claim the instance (enter the code, choose a
password), and pairs itself. Otherwise it prompts for the instance password or reads
`JIG_PASSWORD`; you have neither, and a password must not pass through a chat.

From any other machine, ask the user to open the dashboard's **Setup** page, press **Generate
command** under "Connect the CLI", and paste you the line it produces:

```sh
bunx --bun github:agamm/jig pair <code> --url=https://<their-instance>
```

`bunx` on purpose: it runs from any directory and needs no checkout, so you can paste it
wherever you happen to be. The first run fetches the CLI and takes a moment.

The code is single use and expires in ten minutes, which is what makes it safe to paste. Running
it caches a 30-day session in `~/.config/jig/remotes/`, and every later `jig setup`, `jig update`
and `jig debug` command against that instance works without asking again.

**When setup finishes on a hosted instance it prints a pairing command** (`bunx --bun
github:agamm/jig pair <code> --url=...`). Put that line in your final report and ask the user
whether to run it in their own checkout: the machine that ran setup is paired, theirs usually is
not. The code is single use and expires in ten minutes, so if they say yes, run it right away
from the directory they name; if it has expired, the dashboard's Setup page mints a new one.

**An instance is usually already set up when you pair with it.** The dashboard's Setup page is
how most people onboard, and pairing comes after it (the pairing command is generated on that
page). So `onboarding_complete: true` with OpenRouter, AgentMail and Composio already connected
is the expected state of a freshly paired instance, not a sign that something is off or that the
user skipped a step. Do not call it suspicious or re-run checks to "trust" it: `jig setup` reports
the satisfied steps and skips them, and `jig debug connections` shows what is connected.

**One trap worth knowing for the other commands.** `bun run jig …` needs the clone as your
working directory. One directory above it, `bun run jig` matches the `jig` FOLDER rather than the
package script and exits 0 having printed nothing. Any `bun run jig` command that produces no
output at all means exactly that: check `pwd` before believing the command is broken.

## Create and run a jig

Coding agents are the main way jigs get written, so writing the file yourself and pushing it
is the first-class CLI path. Writing the workflow code itself is a different skill: read
`SKILL.md` in the repo root, completely, before you write or edit any jig.

**Clarify before you write.** "I want a daily email" is not a spec. Before touching code, ask
one question at a time (AskUserQuestion in Claude Code, otherwise in the conversation), each
with a recommended answer, until you know: what it should do, when it should run, what the
content should include, and where the data comes from (which connections). Summarize the plan
in a few lines and wait for the go-ahead. Skip questions the request already answers.

**Then build.** Once the answers are in and the probes are green, write, push and dry-run the jig
in the same turn and report the result. Do not end a turn on a status summary that waits for a
go-ahead you already have; the only questions left are the ones only the user can answer.

```sh
bun run jig types                              # the instance's connection types, into .jig/connections/
# write <jig-id>.ts per SKILL.md, importing from "@jig/connections/<server>.js"
bun run jig edit <jig-id> --file=<jig-id>.ts   # create it: typechecked on the instance, lands PENDING
bun run jig visualize <jig-id>.ts -v           # read the flow back before pushing: steps, AI or code, prompts
bun run jig run <jig-id> --dry-run             # previews the PENDING version, tools stubbed, output printed
bun run jig pending <jig-id>                   # read the diff (works against the remote too)
bun run jig pending <jig-id> approve           # or: discard, or push with --approve
bun run jig run <jig-id>                       # trigger the active version once for real
```

`jig run` prints the run's output when it finishes, and a dry run of a jig that has only a
pending version works; there is no need to call the API by hand with the session cookie.
`jig debug eval` refuses tools whose annotation says they write; when the tool is plainly a read
(list, get, search) rerun it with `--allow-write`, since that annotation is a classifier's guess.

The push runs the instance's own check (tsc against its generated connections, the jig
validator, step structure). Problems are printed,
the code still lands as pending so the diff stays visible, the command exits 1, and
`--approve` is ignored until the check is clean. Read `.jig/connections/<server>.d.ts` for tool
names and parameter types instead of guessing them; `edit --file` creates the jig when it does
not exist and updates it otherwise, so there is one push command.

To change an existing jig the same way:

```sh
bun run jig edit <jig-id> --out=jig.ts             # export the live code
bun run jig edit <jig-id> --file=jig.ts            # upload it as PENDING
bun run jig edit <jig-id> --file=jig.ts --approve  # approve in the same push when the check is clean
```

Export → edit → upload → `jig run <jig-id>` → `jig debug tail` is the loop. Uploading leaves
the change pending on purpose, the same human gate reply-to-email edits use. There is no
in-server writer: you are the author.

**All of these act on the instance you deployed**, not on this machine (so does `jig backup`,
which downloads the instance's archive over the paired session). They resolve the
active remote from `~/.config/jig/remotes/`, use the paired session, and print which instance
they chose before starting. Add `--local` when you mean this machine, or `--handle=<name>` to
pick between several instances.

If the remote has no cached session they refuse rather than quietly acting locally, because a
jig on the wrong instance is a mistake you notice much later. Pair it first: see "Connecting
the CLI to a hosted instance" above.

`jig debug` is diagnostics only:

```sh
bun run jig debug connections            # what is connected, and how many tools
bun run jig debug connections <name> --refresh   # reconnect and rediscover
bun run jig debug ls                     # what is on the remote
bun run jig debug audit                  # what is failing, since when, and the next command (--json, --since=, --jig=)
bun run jig debug tail                   # stream logs
bun run jig debug eval <server> <tool>   # call one tool, see its real shape
```

**Ask before you assert.** `jig debug connections` is how you find out what is connected; a
proxy like Composio can be authorized while nothing is authorized inside it, which reads as
"connected" with zero tools.

**Never drive the dashboard through a browser.** If you find yourself opening Chrome to click
around the dashboard, stop: you cannot authenticate that tab, the password is not yours to
type, and every action there has a CLI equivalent above. A missing capability is something to report, not
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

It authenticates the Railway CLI, creates and links the project, creates the service from the
published image `ghcr.io/agamm/jig` (the checkout's own release when it is published, else
`latest`), mounts a volume at `/data`, generates a domain, waits for `/api/health`, and writes a
manifest to `~/.config/jig/remotes/`. Nothing is built; a deploy is pull plus boot. That manifest
is what later lets `jig update` find the instance. `--yes` takes every default and `--workspace=`
picks the Railway workspace, so an agent can run it without a terminal.

**Ask which Railway account or team to deploy under before running it.** Being logged in is
not consent to use whatever scope is active.

`/data` is the whole instance: credentials, jigs, schedules, runs. A deployment without a
volume loses everything on restart.

On first boot the instance is unclaimed. `jig deploy` prints the one-time setup code next to
the dashboard URL (it also appears in the Railway service logs). The user enters it on the
public dashboard to claim the instance and create their password; never ask them to paste that
code or the password into chat. `jig setup <handle>` from the deploying machine waits for that
claim, pairs itself with the same code, and continues: OpenRouter authorizes with browser OAuth,
AgentMail is required and verified with the owner, and Composio is optional.

The service also gets a `JIG_DATA_KEY` variable. The instance keeps its data key wrapped under
it and unlocks itself after every restart, so updates and redeploys never pause the jigs; the
password is only for signing in. That variable lives on the Railway service alone: never read
it out, print it, or copy it anywhere.

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
bun run jig update <handle>   # move to the newest release, roll back if it fails
```

An instance created from the image switches to the release image `ghcr.io/agamm/jig:v<tag>`
(no build, usually under a minute) and rolls back by switching to the previous image. Older
instances built from source are redeployed with `railway up` as before.

It compares versions numerically and refuses to move an instance onto an older tag, since old
code against a volume whose migrations already ran is data damage rather than a failed update.
An instance deployed before `JIG_DATA_KEY` existed gets the variable during this update; the
unlock at the end of it is the last one a restart will ever need.
If `main` is ahead of the newest tag it correctly refuses; tag the release first
(`git tag v0.2.0 && git push origin v0.2.0`).

Other ways in:

- **A local clone with no instance:** `git pull && bun install` is what `jig update` does.
- **A Railway instance from the template button:** no clone and no manifest, so `jig update`
  cannot reach it. Redeploy the service in Railway, which re-pulls the published image.

Jigs, credentials and schedules live in the database (`/data` hosted, `jig.db` local), never in
the source tree, so updating code does not touch them.

## When something is wrong

Start with the failure log, then read `docs/operations.md` for health triage and the repair
procedure:

- `bun run jig debug failures [handle]` for every failed run in the last seven days, each with
  its cause (`auth`, `composio-spill`, `rate-limit`, `provider`, `timeout`, `credits`,
  `missing-connection`, `locked`, or `code`) and the command that fixes it. The failure email
  the owner received quotes the same verdict. `bun run jig debug audit` is the per-jig view:
  streaks, pending versions, unhealthy connections.
- A tool call that hit a gateway error was already retried before the run failed: reads up to
  three times, writes exactly once (never after a timeout). So a failure in the log is not a
  blip that one more try would fix; act on its remedy.
- `bun run jig doctor` for instance health.
- `bun run jig visualize <jig-id> -vv` to read a jig back without running it: every step, which
  ones a model decides, the prompts word for word, and the branches around them. Start here when
  the user asks why a jig did or did not do something.
- `"SSE error: Non-200 (405)"` means an outbound MCP connection failed to authorize
  (usually expired auth), not a dashboard problem.

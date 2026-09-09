# Deploy, Diagnose, and Heal Jig

This runbook is for coding agents and operators. It covers supported local and Railway paths only.

## Deploy and update

The commands and their order live in the `jig` skill
([`.agents/skills/jig/SKILL.md`](../.agents/skills/jig/SKILL.md)). This runbook keeps only the
constraints that outlive them.

**The published template must stay clean.** It must never contain a maintainer database,
environment variables, OAuth state, credentials, connection schemas, logs, or other runtime
data. GitHub Actions builds `ghcr.io/agamm/jig:latest` from an allowlisted subset of the
public repository; local state and secret paths are excluded from the build context. After
deployment, the owner claims the instance with the one-time code from its service logs, sets a
password, authorizes OpenRouter in the browser, and completes the required AgentMail step.
Optional app connections come afterwards.

**`/data` persistence is not optional.** `deploy --update` refuses to proceed without it and
will attempt to attach a missing volume. Attaching a volume hides any old ephemeral `/data`,
so a deployment that previously ran without one must be treated as a fresh instance.

**A remote update rolls back on a failed health check.** It will not move an instance onto a
version older than the one it runs, because old code against a volume whose migrations have
already advanced is data damage rather than a failed deploy.

```sh
bun run jig doctor
```

### First boot

A new public instance prints a one-time setup code to its service logs. Open the generated
domain, enter that code, and create the instance password. The code is only for claiming the
instance; keep it private.

Continue on the dashboard's **Setup** page. Authorize OpenRouter with browser OAuth (do not
create or paste an OpenRouter key), complete the guided AgentMail setup and owner-email check,
then optionally authorize Composio. To connect a local CLI, use **Generate command** on that
same page; its short-lived pairing code is separate from the first-boot setup code.

## Health triage

Start with:

```sh
bun run jig doctor [handle]
```

Interpret the checks:

- `reachable` failure: inspect Railway build/deploy logs and `/api/health`.
- `password_set` warning: read the current setup code from the service logs and finish
  first-run password setup.
- `unlocked` warning: enter the password (dashboard or `jig unlock`); the scheduler pauses while
  encrypted credentials are unavailable.
- `restart_safe` warning: the service has no `JIG_DATA_KEY`, so every restart locks it. A hosted
  instance normally unlocks itself at boot from that variable, which wraps the data key without
  putting it on the volume or in backups. `jig setup` and `jig update <handle>` add it from the
  machine that deployed the instance (the next restart asks for the password once, then never
  again); from anywhere else, add `JIG_DATA_KEY` with 64 random hex characters under the service's
  Variables in Railway. The dashboard's Setup page shows the same notice.

For remote debug access, avoid putting the password in shell history:

```sh
bun run jig pair <code>          # code from the dashboard's Setup page; no password involved
# Or sign in with the instance password, kept out of shell history:
read -s JIG_PASSWORD && export JIG_PASSWORD
bun run jig unlock [handle]
unset JIG_PASSWORD
```

Then:

```sh
bun run jig run <jig-id> --dry-run
bun run jig run <jig-id>
bun run jig debug tail [handle]
```

The debug stream includes redacted `runner`, `sdk.llm`, `sdk.agent`, `mcp.tool`, `authoring.agent`, `authoring.discovery`, `repair`, `scheduler`, connection, webhook, and Composio events.

## Write or edit a deployed jig from your own editor

`jig edit --file=` exists so a deployed jig can be written and edited in
whatever editor or agent harness you use. There is no in-server writer; the
dashboard hands you copy-ready prompts for a coding agent instead.

```sh
bun run jig debug connections    # connected state and tool count per connection
bun run jig debug ls [handle]
bun run jig types                # the instance's connection types, into .jig/connections/
bun run jig edit <jig-id> --out=/tmp/<jig-id>.ts      # export an existing jig (skip for a new one)
# edit the file
bun run jig edit <jig-id> --file=/tmp/<jig-id>.ts --message="what changed"   # creates the jig if new
bun run jig run <jig-id> --dry-run
```

A clean push goes **live**: the server typechecks the code against its generated
connections and runs the jig validator, and only a clean result is promoted.
Problems come back and are printed, and the code lands as **pending** with its
diff; `--pending` holds a clean push the same way, and
`jig pending <jig-id> approve|discard` closes it from the CLI. A push also
applies the same guards as reply-to-email edits: it rejects code importing
disconnected servers, and refuses while the jig is running or while an email
edit session holds it. A jig whose only version is pending is listed with a
"pending" status, never hidden.

### Test a connection before writing code against it

```sh
bun run jig debug eval composio googlecalendar_events_list --args='{"max_results":3}'
```

Calls one tool on the live connection and prints a depth-limited shape
descriptor plus a redacted, truncated preview of the real payload. Use it to
learn the actual response shape before writing unwrap code, rather than shipping
a jig and reading the logs to discover the key was `data.items` and not
`results`.

Tools whose annotations do not mark them read-only are refused unless
`--allow-write` is passed, and the same Composio spill detection applies: args
that would overflow the inline response are reported as a refusal with the
reason, not returned as a truncated shape.

When a reply-to-email edit gets a jig wrong, fix `SKILL.md` too, or the next
generated fix repeats the defect.

## Repair a failing jig

Start with `bun run jig debug failures [handle]`: every failed run of the last seven days, newest
first, with the failing step, the error, the cause the classifier recognised and the exact next
command (see "Failure log" below). Then `bun run jig debug audit [handle]` for the per-jig view:
consecutive-failure count, any pending fix already waiting, unhealthy connections, and the same
remedy. Both take `--jig=<id>` and `--json`.

When the question is what the jig does rather than whether it ran, `bun run jig visualize <jig-id> -vv` reads the
active version back as a flow: every step, which ones a model decides, the prompts word for word, and the branches
around them. `-v` gives the shorter form, `--json` the raw analysis, and a `.ts` path works for code not pushed yet.

1. Reproduce with `jig run <jig-id> --dry-run` when the failure can be observed without writes.
2. Identify the first failing step and its exact tool/model error.
3. Separate code defects from external blockers such as revoked access, provider outages, or missing connections.
4. Make the smallest change that preserves the jig's trigger, recipients, tools, step order, and output shape.
5. Review the pending diff before approval.
6. Run a dry run, then one real run if writes are required for proof.

Useful version commands:

```sh
bun run jig versions <jig-id>
bun run jig pending <jig-id>
bun run jig pending <jig-id> approve
bun run jig pending <jig-id> discard
bun run jig restore <jig-id> <version>
```

Restore always creates a pending version. Review and approve it; do not bypass the approval boundary.

## Failure log

Every failed run is kept in the runs table with its failing step and error, and read back
classified: `GET /api/failures?since=7d[&jig=<id>]` and `bun run jig debug failures`. Nothing
is repaired automatically; the log exists so that whoever fixes the jig (the owner from the
email, or a coding agent from the CLI) starts from the cause rather than from the stack trace.

A coding agent in Claude Code gets the first look without asking: `.claude/settings.json` in
this repo runs `bun run jig debug audit --hook` when a session starts in the checkout. Hook
mode prints nothing when the checkout is not paired, one line when the instance cannot answer,
otherwise the audit under a read-me-first header, and it never exits non-zero. A session that
was already open when the file arrived picks it up after `/hooks` or a restart.

The classifier matches the error text and names the remedy:

| cause | recognised from | remedy |
|---|---|---|
| `composio-spill` | Composio spilled a result past its inline limit to a sandbox file | connect the service's own MCP server (`jig connect <service>`) or ask for less |
| `auth` | 401/403, `invalid_grant`, revoked or expired authorization | `jig connect <server>` to re-authorize |
| `missing-connection` | preflight found an imported connection that is not set up | `jig connect <name>` |
| `credits` | OpenRouter 402 | top up credit |
| `rate-limit` | 429, quota | wait; do less per run |
| `provider` | 5xx, network errors, SSE failures | wait; `jig debug connections` if it persists |
| `timeout` | the run or a tool ran past its timeout | raise the timeout in the jig options or do less per run |
| `locked` | credentials unreadable because the instance was locked | `jig unlock`; `JIG_DATA_KEY` keeps it from recurring |
| `code` | nothing external recognised | `jig edit --out`, fix, `--file`, dry run |

Failure emails quote the same cause and remedy, and end with a prompt a coding agent can take
as-is. Their cadence per jig: the first failure emails, the second says repeat alerts are paused,
then one summary every 24 hours while it keeps failing; a success clears the incident. Replying
to any of them still opens the jig's reply-to-edit session.

### Retries

Before a failure reaches the log, the tool call that failed is repeated on gateway and transport
errors (a dropped session, `MCP error -32000: Upstream MCP server error`, a reset socket). Only
that one call is repeated, with the same arguments; nothing earlier in the step runs again.

| Tool | Repeats | Why |
|---|---|---|
| read (`readOnlyHint` true) | up to 3, with backoff | repeating a read changes nothing |
| write | exactly 1, never after a timeout | a gateway rejection usually never reached the provider; a timeout means the request was accepted and may still complete |
| any, when the provider itself answered with an error | 0 | it would fail the same way, or duplicate |

A repeated write can still duplicate when the provider had applied it before the reply went
missing. That is the trade made for far fewer dead runs; each repeat is logged as
`[mcp.connection] reconnect` with `readOnly: false`, so a duplicate can be traced to its run.

## Privacy checklist

Before publishing code or a deployment template:

```sh
git status --short
git diff --check
git ls-files
```

Confirm that `.env`, `.jig/`, `jig.db*`, `jig.log`, `runtime/`, and `tmp/` are absent from tracked files. Scan the current tree and Git history for secret formats and personal identifiers. A Railway template must be generated from a clean seed project with a blank `/data` volume, never from a live personal instance.

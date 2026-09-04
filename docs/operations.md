# Deploy, Diagnose, and Heal Jig

This runbook is for coding agents and operators. It covers supported local and Railway paths only.

## Deploy and update

The commands and their order live in the `jig` skill
([`.agents/skills/jig/SKILL.md`](../.agents/skills/jig/SKILL.md)). This runbook keeps only the
constraints that outlive them.

**The published template must stay clean.** It must never contain a maintainer database,
environment variables, OAuth state, credentials, connection schemas, logs, or other runtime
data. GitHub Actions builds `ghcr.io/agamm/jig:latest` from an allowlisted subset of the
public repository; local state and secret paths are excluded from the build context. Users add
their own password, model access, and connections after deployment.

**`/data` persistence is not optional.** `deploy --update` refuses to proceed without it and
will attempt to attach a missing volume. Attaching a volume hides any old ephemeral `/data`,
so a deployment that previously ran without one must be treated as a fresh instance.

**A remote update rolls back on a failed health check.** It will not move an instance onto a
version older than the one it runs, because old code against a volume whose migrations have
already advanced is data damage rather than a failed deploy.

```sh
bun run jig doctor
```

## Health triage

Start with:

```sh
bun run jig doctor [handle]
```

Interpret the checks:

- `reachable` failure: inspect Railway build/deploy logs and `/api/health`.
- `password_set` warning: finish first-run password setup.
- `unlocked` warning: open the dashboard and unlock it; the service scheduler pauses while encrypted credentials are unavailable.

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

`jig new|edit --file=` exist so a deployed jig can be written and edited in
whatever editor or agent harness you use, rather than only through the
dashboard's authoring agent.

```sh
bun run jig debug connections    # connected state and tool count per connection
bun run jig debug ls [handle]
bun run jig types                # the instance's connection types, into .jig/connections/
bun run jig edit <jig-id> --out=/tmp/<jig-id>.ts      # export an existing jig (skip for a new one)
# edit the file
bun run jig edit <jig-id> --file=/tmp/<jig-id>.ts --message="what changed"   # creates the jig if new
bun run jig run <jig-id> --dry-run
```

A push leaves the change **pending** unless you pass `--approve`, so the default
keeps the same human approval gate the dashboard and auto-repair use;
`jig pending <jig-id> approve|discard` closes it from the CLI. The server
typechecks the code against its generated connections and runs the jig
validator; problems come back and are printed, the code still lands as pending,
and `--approve` only takes effect when the check is clean. It also applies the
same guards as the authoring agent's own write path: it rejects code importing
disconnected servers, and refuses while the jig is running or while an authoring
session holds it.

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

When a jig the authoring agent generated is wrong, fix `SKILL.md` too, or the
next generated jig repeats the defect.

## Repair a failing jig

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

## Built-in self-healing

After two consecutive real-run failures, Jig may start an authoring repair session using the latest failing step and error. It attempts a code fix only when a code change can resolve the failure. External outages and revoked credentials are reported as blockers instead of triggering speculative edits.

Repairs are approval-gated:

- a proposed version is pending, never immediately active;
- an existing pending version blocks another repair attempt;
- live user edits take priority over background repair;
- the automatic attempt window stops runaway repair loops;
- AgentMail can deliver the proposal in a reply-to-approve thread.

## Privacy checklist

Before publishing code or a deployment template:

```sh
git status --short
git diff --check
git ls-files
```

Confirm that `.env`, `.jig/`, `jig.db*`, `jig.log`, `runtime/`, and `tmp/` are absent from tracked files. Scan the current tree and Git history for secret formats and personal identifiers. A Railway template must be generated from a clean seed project with a blank `/data` volume, never from a live personal instance.

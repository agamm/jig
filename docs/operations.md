# Deploy, Diagnose, and Heal Jig

This runbook is for coding agents and operators. It covers supported local and Railway paths only.

## Deploy a clean instance

The README's Deploy on Railway button provisions a new service from the public
`ghcr.io/agamm/jig:latest` image plus a blank persistent volume mounted at
`/data`. GitHub Actions builds that image from an allowlisted subset of the
public repository; local state and secret paths are excluded from the build
context.

The template must never contain a maintainer database, environment variables, OAuth state, credentials, connection schemas, logs, or other runtime data. Users add their own password, OpenRouter key, and connections after deployment.

CLI alternative:

```sh
bun install
bun run jig deploy
```

The deploy wizard:

1. authenticates the Railway CLI;
2. creates and links a project;
3. creates a service;
4. mounts a persistent volume at `/data`;
5. deploys the repository;
6. creates a public domain;
7. waits for `/api/health`;
8. saves a local remote manifest under `~/.config/jig/remotes/`.

After the service is healthy:

1. open the generated URL;
2. set the instance password;
3. authorize OpenRouter when the dashboard asks (browser flow; pasting a key in Settings stays available as a fallback);
4. connect only the services the jigs need;
5. configure AgentMail so failures reach you; `bun run jig setup` walks through this and the steps above, and verifies each one.

## Update safely

```sh
bun run jig deploy --update
bun run jig doctor
```

`deploy --update` refuses to proceed without `/data` persistence and will attempt to attach a missing volume. Attaching a volume hides any old ephemeral `/data`, so a deployment that previously ran without a volume must be treated as a fresh instance.

Use `bun run jig update [handle]` for the remote update flow. It rolls back when the new deployment fails its health check.

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
read -s JIG_PASSWORD && export JIG_PASSWORD
bun run jig debug login [handle]
unset JIG_PASSWORD
```

Then:

```sh
bun run jig debug run <jig-id> [handle] --dry-run
bun run jig debug run <jig-id> [handle]
bun run jig debug tail [handle]
```

The debug stream includes redacted `runner`, `sdk.llm`, `sdk.agent`, `mcp.tool`, `authoring.agent`, `authoring.discovery`, `repair`, `scheduler`, connection, webhook, and Composio events.

## Edit a deployed jig from your own editor

`pull` and `push` exist so a deployed jig can be edited in whatever editor or
agent harness you use, rather than only through the dashboard's authoring agent.

```sh
bun run jig debug ls [handle]
bun run jig debug pull <jig-id> --out=/tmp/<jig-id>.ts
# edit the file
bun run jig debug push <jig-id> /tmp/<jig-id>.ts --message="what changed"
bun run jig debug run <jig-id> --dry-run
```

`push` leaves the change **pending** unless you pass `--approve`, so the default
keeps the same human approval gate the dashboard and auto-repair use. Approve or
discard from the dashboard. The server applies the same guards as the authoring
agent's own write path: it rejects code importing disconnected servers, and
refuses while the jig is running or while an authoring session holds it.

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

A hand-written push is a repair, not a design change. When the jig is wrong
because the authoring agent generated it wrong, fix `SKILL.md` too, or the next
generated jig repeats the defect.

## Repair a failing jig

1. Reproduce with `debug run ... --dry-run` when the failure can be observed without writes.
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

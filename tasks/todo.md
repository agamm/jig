# Agent-first Jig: remove in-server authoring, examples as prompts, settings in SDK, audit log (2026-09-04)

Plan: ~/.claude/plans/wondrous-humming-donut.md. Archive branch: archive/in-server-authoring (pushed).

## Step 1: Part B (remove interactive authoring) + Part G (copy prompts)
- [x] Server: agent-service trims, /api/agent* routes, contracts, dead code (buildCreatorJigPrompt, jig-gen ask thread), tests
- [x] Dashboard: delete create pane / agent panel / input / activity / draft banner / busy frame / review pane / use-agent / use-input-history; trim shell, detail pane, jig list, onboarding, pending banner, run-steps, lib
- [x] Dashboard: copy-button.tsx, agent-prompts.ts, copy buttons (change, fix, new jig), setup READY card reworded
- [x] CLI: no `new`, flagless `edit` is usage, session.ts gone, help text
- [x] Docs touched by step 1
- [x] Green: bun test, root tsc, dashboard tsc; commit

## Step 2: Part D (editor role)
- [x] Merged as d043a37 (740 pass)
## Step 3: Part C (examples as prompts)
- [x] Merged (739 pass)
- [x] Step 6: deleted the unused refreshJigs helper in dashboard-shell.tsx
## Step 4: Part E (settings in the SDK + migration + SKILL.md)
- [x] Merged as 0babffc (754 pass)
## Step 5: Part F (audit log + jig debug audit)
- [x] Merged (all green)
## Step 6: version bump, Part H doc sweep, push main
- [x] Audit every remaining "authoring agent" mention (validate.ts messages, SKILL.md, agentmail-settings.tsx, notify.ts, classify-reply.ts, docs/jig-architecture.svg): keep only where it means the headless email/repair loop
- [x] FirstJig card uses newJigPrompt wording (self-contained for a checkout); dead .construction-stripe CSS dropped (Part C)

## Review

- Five commits on main after the archive branch: authoring removal (42 files, -3150), editor role, examples as prompts, SDK settings (+ migration v24), audit log. Version 0.1.131.
- Verified: 772 tests, root and dashboard typechecks, whitespace; end to end against a scratch instance over HTTP as a paired clone: `jig edit --file --approve` with model/runTimeoutMs/toolTimeoutMs in source (modelInCode reported, override fields gone), a failing run, `jig debug ls`, `jig debug audit` text and --json naming the step, error and next command; `/api/agent` 404; `/api/models` main+fast; `/api/examples` prompts; dashboard pages 200 with a clean dev log.
- Not verified: the dashboard visually (Chrome extension disconnected during the smoke); the email question round-trip and auto-repair against live AgentMail (unit tests only).
- Left for later, deliberately: the "failed again" and 24h summary email bodies do not yet name the failing step (only the first failure email does); the natural-language trigger editor stays.

# Onboarding setup lock and 80/20 UX/DX fixes (2026-09-04)

- [x] Make setup readiness authoritative and keep incomplete instances directed to Setup.
- [x] Render the shared setup flow's instructional and recommendation events in the dashboard.
- [x] Remove the unsafe default port-kill behavior and the documented local setup/start conflict.
- [x] Show and confirm the active Railway identity/scope before provisioning.
- [x] Add useful CLI help/argument validation and pin the dashboard package-manager path.
- [x] Fix optional-connection completion copy without changing setup requirements.
- [x] Refresh stale onboarding/developer documentation.
- [x] Add focused tests, then run the full suite, root/dashboard typechecks, build, and diff checks.

## Review

- Setup is now a real gate in local and service modes: only verified required steps can persist completion, and the dashboard stays on Setup until then.
- The dashboard renders shared instructions and Composio recommendations; the completion card says Jig is ready without implying optional apps are connected.
- Local CLI setup owns and stops its temporary API server. `jig start` never kills a listener by default and chooses another port non-interactively.
- Railway deploy shows the active login and requires an explicit account/workspace confirmation before `railway init`.
- Setup help rejects ambiguous/unknown arguments; updates install both frozen lockfiles; dashboard pins pnpm 10.15.1 and the stale Bun lockfile is removed.
- Docs now use the actual first-boot claim, OAuth, AgentMail, optional Composio, CLI pairing, and local start sequence.
- Verified: 783 tests, root and dashboard TypeScript checks, `pnpm run build`, `jig setup --help`, and `git diff --check` all pass.
- Not browser-smoke-tested: the Jig operating skill disallows automating the dashboard; production compilation and component typechecking cover this change.

# Hosted onboarding: image deploys, non-interactive by flag, setup code hand-off, self-pairing (2026-09-04)

- [x] `jig deploy --yes --workspace=<name>`: prompts take defaults, destructive confirms answer no, no stdin hang
- [x] Service created from ghcr.io/agamm/jig:v<version> (falls back to latest), setup code + timezone as variables
- [x] Volume and domain through the Railway API (no CLI prompt); listing lag handled
- [x] Setup code printed with the dashboard URL and kept in the manifest; server accepts JIG_SETUP_CODE
- [x] After the owner claims, the same code pairs the deploying machine once; `jig setup <handle>` waits and continues
- [x] `jig update <handle>` switches the image for image-based instances, rolls back by switching back
- [x] Docs: skill, README, llms.txt, railway template

## Review

- Verified live against a throwaway project in the user's Railway workspace (deleted afterwards): a full non-interactive deploy took about 36s end to end; claim with the setup code; `jig setup` paired itself and reached the OpenRouter step; `jig debug ls` worked on the paired session; image update from 0.1.136 to v0.1.137 completed and unlocked.
- Not verified live: the rollback branch of the image update (needs a failing image); the CLI fallback for the volume at a terminal.
- First live run exposed a race: the CLI's volume listing lags the API create by seconds; the check now retries and treats the API's volume id as proof.

# Never-lock instance key + failure log replacing auto-repair (2026-09-07)

Handoff: HANDOFF.md (design agreed 2026-09-06). Three commits, one version bump to 0.1.141.

## A. Remove the auto-repair loop (mechanical)
- [x] Delete src/services/run-repair.ts; move summarizeFailureStreak into run-failure-notify.ts
- [x] run-failure-notify.ts: drop startAutoRepair dep, the fire-and-forget call, and the auto-repair email line
- [x] audit.ts / audit-render.ts / shared/api.ts: drop likelyRepair and the "(auto-repair)" label
- [x] agent-service.ts: drop origin "repair"; email-agent-bridge.ts + email-inbound.ts + classify-reply.ts: drop propose mode and the reply-to-approve routing
- [x] db.ts: email_threads approval column stays (legacy rows), type/docs updated
- [x] dashboard log-view.ts / logs-settings.tsx / cli-debug whitelist: drop the repair kind; fix comments
- [x] Delete test/run-repair.test.ts; update test/audit.test.ts (likelyRepair assertions encode the removed feature)
- [x] bun test + tsc (root + dashboard) green; grep sweep

## B. Instance key (JIG_DATA_KEY)
- [x] test/data-key.test.ts first (boot unlock, no wrap stays locked, unlock wraps, lock deletes wrap, changePassword re-wraps, bad key)
- [x] password.ts: key.wrapped setting, wrap on setPassword/unlock/changePassword, tryAutoUnlock(envKeyHex), lock() deletes wrap
- [x] server.ts createApiServer: service mode + password set -> tryAutoUnlock from env, log outcome
- [x] backup: exclude key.wrapped from settings
- [x] cli-deploy: mint JIG_DATA_KEY into the service variables (never printed, never in manifest)
- [x] cli-remote/update.ts: set JIG_DATA_KEY via railway API when the service lacks it, before the image switch
- [x] Remove .alert-key cache (agentmail.ts, auth.ts) and the 60-minute lock alert (scheduler); delete test/locked-alert.test.ts
- [x] Docs: operations.md lock lines, README security note, agent skill, unlock.ts header, railway-template.md
- [x] Local service-mode boot check with a scratch data dir: set password, restart, health locked:false

## C. Failure log
- [x] src/services/failure-class.ts pure classifier + table test
- [x] db.ts listFailedRunsSince; services/failures.ts builds the log; GET /api/failures?since=&jig=
- [x] jig debug failures [handle] [--since] [--jig] [--json] + text renderer
- [x] audit: class + remedy on lastFailure; audit-render prints the remedy line
- [x] failure emails quote the class and remedy (all three cadences)
- [x] Docs: agent skill (ground rule + "when something is wrong"), operations.md ("Failure log" section), llms.txt, README, root SKILL.md rule 15

## D. Ship
- [x] Bump both package.json to 0.1.141, bun test, tsc, git diff --check, commit, push, tag
- [x] Update memory feedback_agent_first_product.md (loop kept for email replies only)
- [ ] Ask Agam: throwaway Railway deploy for the live restart check, and jig update jig-rp3l
- [x] Missing-key visibility (2026-09-07, follow-up): health restart_safe, jig doctor check, jig setup adds the variable or prints the clicks, Setup page notice; template gets `${{secret(64, "0123456789abcdef")}}` on Agam's side

## Review

- Three commits on main: auto-repair removal (migration v25 drops email_threads.approval), JIG_DATA_KEY auto-unlock, the failure log. Version 0.1.141.
- Verified: 853 tests, root and dashboard typechecks, whitespace. Service-mode boot against a scratch data dir: claim, restart with the key -> locked:false with no unlock; without it -> locked:true; wrong key -> locked:true with the re-wrap hint. Local HTTP: GET /api/failures returns classified entries with the reconnect command naming the step's connection; bad since -> 400.
- Not verified: a real Railway restart (needs a throwaway deploy under the Jig workspace, or `jig update jig-rp3l`), and the Railway GraphQL variables query/upsert against a live service (shapes confirmed by introspection only).
- Left deliberately: the Railway template still sets no variables, so template-button instances keep locking on restart until the owner adds JIG_DATA_KEY (documented in README, operations.md and docs/railway-template.md). The classifier is string matching on run.error; extend RULES in src/services/failure-class.ts when a new class shows up.

# jig backup on the deployed instance (2026-09-07)

- [x] `jig backup` / `jig backup restore` follow the authoring target rule: deployed instance over the paired session (GET /api/backup, POST /api/backup/restore), `--local` in-process, `--handle=` to choose. Downloaded archives are parsed before being kept.
- [x] test/backup-cli.test.ts (stubbed fetch: cookie, credentials flag, truncated download refused, 401/423 named, restore body and flags, --local never touches the network); real-route run against a scratch server.
- [x] Docs: README, llms.txt, agent skill, CLI help. Version 0.1.143.

# Setup page exit and its home under Settings (2026-09-07)

- [x] Setup header shows "Go to dashboard" once the required steps are ready (full load so the gate re-reads health); Re-check demotes to subtle.
- [x] Setup moved under Settings > Setup; sidebar item removed; `?view=setup` links still land there; CLI hint and docs updated.
- [x] Agent skill: a freshly paired instance is usually already onboarded (dashboard first, pairing after), not suspicious.
- [x] Verified in the browser against a scratch instance: Settings > Setup tab and the compat link; the ready-state button not seen live (needs real keys). Version 0.1.144.

# Retry writes once, agent prompt in failure emails (2026-09-07)

- [x] Tool calls: reads keep 3 backoff retries; writes get exactly one repeat on a gateway rejection (-32000, transport reset) and never after a timeout; provider-answered errors are never repeated. The repeat is the same single call with the same args. Logged as `[mcp.connection] reconnect` with readOnly.
- [x] Failure classifier: `MCP error -32000: Upstream MCP server error` -> provider.
- [x] Failure emails (all three cadences) end with a paste-ready coding-agent prompt.
- [x] TDD: test/mcp-client.test.ts (policy + real callTool path), failure-class, run-failure-notify. Real check: a stdio MCP server rejecting the first call with -32000 through callTool + invokeWithMcpReconnect. Docs: operations.md Retries table, agent skill. Version 0.1.145.
- [ ] Still open: "Re-check" on Composio rewrites its schema with the 7 meta-tools and no annotations (verify path); a failed annotation LLM call resets every label to write. Breaks dry-run stubbing and introspection, not retries any more.

# Setup page fixes and the pairing hand-off (2026-09-07)

- [x] Popup detection: window.open with "noopener" returns null even when the tab opened, so every step showed the "blocked" link. Open, then sever the opener by hand. Link text now names the tab's purpose and hides once the step asks its next question.
- [x] OAuth callback for OpenRouter returns to Settings > Setup, not the jig list.
- [x] jig setup on a hosted instance prints a single-use pairing command at the end; the skill tells the agent to report it and offer to run it in the user's checkout; README prompt asks for it.
- [x] Verified: 865 tests, both typechecks; /api/cli/pair minted (600 s) and the code claimed on a scratch server. Not seen live: the dashboard link wording. Version 0.1.146.

# Restore never touches the password; README rewrite (2026-09-07)

- [x] Backups no longer carry instance-local settings (session.hmac_secret, health.last_check, onboarding_complete, key.wrapped, failure_incident.*, connection_status.*, system_notify.sent.*); a restore ignores them if an old archive has them.
- [x] Restore never writes password.salt/canary. Different password: the backup's password (CLI --backup-password / JIG_BACKUP_PASSWORD / hidden prompt, API header x-jig-backup-password, dashboard field) opens the credentials and they are re-encrypted under the instance's own key; else skipped. --force removed. Unreadable rows skipped with a count.
- [x] README rewritten: five reasons, alpha warning, how it works, agent-to-Railway workflow, security table, agent pointers.
- [x] Verified: 867 tests, both typechecks; real two-instance run over HTTP (A backed up, restored onto B with A's password: B's session kept, credential readable, only B's password unlocks). Version 0.1.147.

# Pushed jigs go live; no more orphan sweep (2026-09-07)

- [x] Root cause of the vanished jig: the daily maintenance sweep deleted every jig with no active version and no agent session, which is exactly a CLI-pushed jig awaiting approval; it ran on the first tick after every boot. Sweep removed (it served the deleted in-server authoring flow).
- [x] /api/jigs lists a pending-only jig with status "pending" and its pending code (dashboard dot in blue); it was hidden before.
- [x] `jig edit --file` ships a clean push by default; `--pending` holds it; problems still land pending and exit 1. Docs, prompts, skill, help updated.
- [x] Tests: cli-push flipped to the new default (the old ones encoded pending-by-default), jig-store sweep test replaced by "a pending-only jig is kept", new jig-api test. Version 0.1.148.

# Reply-to-edit after a restore; writer model; SKILL.md in the image (2026-09-08)

- [x] AgentMail webhook: list by client_id, delete when it points elsewhere, recreate at this URL; registered URL stored; status reports webhookMismatch; the AgentMail setup step re-points on Re-check; boot warns when replies go elsewhere (no auto-move: two live instances would fight).
- [x] Writer model slot (default anthropic/claude-sonnet-5) used by the reply-to-edit agent; Models tab card with Claude/OpenAI-first recommendations.
- [x] Dockerfile copies SKILL.md; the edit agent warns when it is missing.
- [x] Tests: agentmail-webhook (stubbed AgentMail API), models slot test. 873 pass. Version 0.1.150.
- [x] Runs + spend graph on the jigs page: runs.cost_usd (migration v26) summed from OpenRouter usage accounting (`usage: {include: true}`) on every SDK model call; GET /api/activity?since= buckets runs and spend per day in the scheduler timezone with a previous window (null past retention); ActivityPanel (tiles, stacked bars, spend line, tooltip, 7d/30d/90d) above the jig list; per-jig cost chips live. Writer slot excluded from price-driven upgrade nudges. 879 pass. Seen in the browser on a seeded scratch instance. Not verified live: OpenRouter's `usage.cost` field on a real call. Version 0.1.151.


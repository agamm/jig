# Onboarding: a two-minute, agent-driven install

Goal: someone lands on the GitHub repo, pastes one line into Claude Code or
Codex, and has a running Jig instance with verified connections and a first jig
in two to three minutes. The agent is the installer. Jig becomes headless-first:
the dashboard stays, but the primary surface is the CLI driven by an agent.

## Decisions (settled with the user before planning)

- **Deploy provisions the published template image**, not a source upload.
  `railway init` then `railway deploy -t jig` pulls `ghcr.io/agamm/jig:latest`.
  No Nixpacks build, so build failure stops being a way install can break.
- **The clone + the `jig` bun CLI is the control surface. No MCP server.**
  Footprint and control are one decision, not two: with a clone on disk the CLI
  already is the agent's toolset (`jig debug run|tail|ls|pull|push|eval`), and
  an MCP server would be a second way to do what bash already does. MCP only
  earns its cost in a no-clone world, which we are not building.
- **Auto-unlock reads the password from the OS keychain**, falling back to the
  0600 manifest where no keychain exists. Server-side posture is unchanged.
- **Composio recommends Gmail, Google Calendar, and Telegram-or-Slack.**
- **The wizard advances one step at a time**, and a connection step never
  advances on "a schema file exists". It advances only on a real call that
  returned data.

## Findings (verified before planning, not assumed)

- **The template deploy is PROVEN end to end** (run 2026-08-22 into a scratch
  dir, project `jig-tmpl-test`). Every step non-interactive, no human input
  after login: `railway init --name X --workspace Y --json` creates the
  project; `railway deploy -t jig` creates the service from
  `ghcr.io/agamm/jig:latest` AND auto-provisions the `/data` volume (5GB,
  Ready) AND auto-generates the public domain; `railway status --json` read
  SUCCESS on the first poll (no build, so it is fast); `railway logs -s jig
  --lines 400` returned the setup code; `POST /api/setup-password` with that
  code returned 200 and a session cookie. `/api/health` reported `/data`
  mounted, writable, persistent.
- **TIMED COLD RUN (2026-08-22, from `railway logout`): 25 seconds of machine
  time.** `init` 1s, `deploy -t jig` returned at 5s, deployment SUCCESS at 23s,
  domain and health 200 at 24s, setup code read from logs and instance claimed
  at 25s. So the 2-3 minute target is not constrained by machines at all. Every
  remaining second is human: the Railway browser auth, the OpenRouter and
  Composio authorizations, and the single AgentMail paste. Optimise the human
  steps, not the deploy.
- Because the template brings its own volume and domain, the existing
  `railway volume add` and `railway domain` calls in `cli-deploy/index.ts` are
  NOT needed on this path. Keep the verification, drop the provisioning.
- Every railway command needs stdin closed (`< /dev/null`). Flags are honoured,
  but the CLI still prints its prompt lines and will wait on an open stdin.
- `railway logs` streams by default and never exits. `--lines N` (or `--since`)
  makes it fetch history and exit. The wizard must always pass one.
- `railway whoami --json` returns `workspaces[]` directly. Better than deriving
  them from `railway list --json`, and it works on an account with 0 projects.
- Railway CLI 5.41.1 is already agent-aware. `railway login` auto-detects a
  coding agent and opens a browser (`--browserless` is explicitly the wrong
  flag when a human is present). `railway init --name X --workspace Y --json`
  is fully non-interactive. `railway deploy -t <code>` provisions a template.
- The `jig` template is live in the marketplace: code `jig`, id
  `b0ccbaa9-5d0f-4e75-b17e-e294119e4cb7`. It had `deploymentCount: 0` before
  this test, which is now the first completed deploy through it.
- **The published image only ever tracks `origin/main`.** The test instance came
  up as v0.1.85 while the working tree is at v0.1.99, because `origin/main` sits
  at `5c2b172` and local `main` is 10 commits ahead and unpushed. The publish
  workflow fires on push to main and is working correctly. Onboarding quality is
  capped by what has been pushed, so a release has to precede the launch.
- `railway list --json` returns each project with `workspace: {id, name}`, so
  workspaces are derivable for an existing user. A brand-new account with zero
  projects returns `[]` and yields no workspace name. (Fallback via
  `railway api` GraphQL is UNVERIFIED.)
- `src/cli-deploy/index.ts` blocks an agent in four places: `prompt()`,
  `confirm()`, and `railwayInteractive` inheriting stdin for `login` and
  `volume add`. It also never asks which workspace, so it silently takes the
  CLI default. That violates the deploy-scope rule in the global guidelines.
- `introspectToolOutput` (`src/services/introspect.ts`) already handles the
  read-only gate, composio proxy wrap/unwrap, spill detection and redaction.
  Per-connection verification reuses it rather than reimplementing a probe.
- `shared/connect-flow.ts` already establishes the right pattern: shared logic
  emits structured events, `cli.ts` renders them as text and the dashboard
  renders them as UI. The setup wizard is a third consumer of that pattern, not
  a new state-machine API.
- `cli-remote/manifest.ts` already writes dir `0700` / file `chmod 0600` and
  already stores a 30-day admin `session_cookie`. So the laptop is already a
  full-access credential; adding a password widens an existing exposure rather
  than creating a new category.
- AgentMail has NO OAuth for the first API key (docs checked, not just
  recalled). Free tier is 3 inboxes / 3,000 emails per month / 3 GB, no credit
  card. The 3-inbox cap collides with per-jig inboxes.
- OpenRouter supports OAuth PKCE, so the key never has to be pasted. Jig does
  NOT implement it today: `unlock-gate.tsx:206` just links to openrouter.ai/keys
  and asks for a paste. Adding it removes one of the three manual paste steps in
  onboarding.
- Encryption at rest (`crypto/password.ts`): PBKDF2-SHA256 600k iterations,
  AES-256-GCM per row, key in process memory only. Salt and canary live in the
  same SQLite file as the ciphertext, so a volume reader already holds
  everything except the password. **A key file on `/data` would therefore
  destroy the only threat this design defends against.** Keychain does not.
- `node_modules` is line 1 of `.gitignore`, 0 files tracked, never committed.
  Nothing to clean up.
- **`.gitignore` ignores `.agents/` and `.codex/`.** A cross-agent skill cannot
  be committed until those entries are removed.

## 0. Unblock

- [ ] Remove `.agents/` and `.codex/` from `.gitignore` (blocks shipping the skill)
- [x] Deploy the template end to end once and record what happens. Done
      2026-08-22, full chain verified. See Findings.
- [ ] Push `main` and cut a release so `ghcr.io/agamm/jig:latest` stops being 10
      commits behind. Nobody should install v0.1.85.
- [ ] Decide what the README's Railway button becomes. A button install yields
      no clone and therefore no CLI, which is a different product from the one
      this plan builds. Either demote it or document it as a dashboard-only tier.

## 1. Make the deploy path agent-drivable

- [ ] Replace `prompt`/`confirm` in `cli-deploy/index.ts` with flags plus
      `--json`. No readline on any path an agent takes.
- [ ] Add workspace selection: list from `railway list --json`, present the
      choices, require an explicit pick, pass `--workspace`. Never take the CLI
      default. Handle the empty-list (new account) case.
- [ ] Switch the default from `railway up` to `railway init` + `railway deploy
      -t jig`. Keep source upload behind `--from-source` for contributors.
- [x] Confirmed the template brings its own `/data` volume and public domain,
      so drop the `volume add` and `domain` provisioning calls on this path.
      Keep the authoritative `hasVolumeAtPath` check, since a missing volume
      silently wipes SQLite on every redeploy.
- [x] Confirmed the setup code is readable via `railway logs -s <svc> --lines N`
      and that `POST /api/setup-password` claims the instance with it. Wire this
      into the wizard so no human reads log output.
- [ ] Close stdin on every railway invocation, always pass `--lines` to logs,
      and pass `--yes` to `delete` and `unlink` (both prompt otherwise and fail
      with "Cannot prompt for confirmation in non-interactive mode").
- [ ] `railway login` has a HARD 5-MINUTE DEADLINE on its loopback callback
      ("Authentication timed out, no callback received after 5 minutes", exit 1).
      Observed live. The wizard must say the clock is running, detect the
      timeout, and offer to re-run rather than reporting a stale error. It also
      sends `cli_caller=claude_code` in the auth URL, so Railway explicitly
      supports being driven by an agent.
- [ ] FIX A REAL BUG surfaced by the teardown: Railway deletion is SCHEDULED,
      not immediate. The service 404s within seconds but `railway list` still
      returns the project a minute later. `runDeploy`'s orphan-collision path
      deletes, immediately re-lists, and `process.exit(1)`s when the project is
      still present, so it fails on a SUCCESSFUL delete. It breaks exactly in
      the recovery path it exists for. Poll with a timeout, or treat an accepted
      delete as success per Railway's own guidance.

## 2. `jig setup`: the one-step-at-a-time wizard

- [x] `SetupEvent` union + `runSetupFlow` driver in `shared/setup-flow.ts`,
      mirroring `ConnectEvent`. 9 tests in `test/setup-flow.test.ts`.
- [x] `src/cli-setup/index.ts` renders the events and supplies I/O. Wired as
      `jig setup [handle] [--url=] [--openrouter-key=] [--agentmail-key=]
      [--owner=] [--skip-optional] [--yes]`.
- [x] AGENT-SAFE: no readline on any path an agent takes. Secrets come from
      flags or env; with no TTY and no flag it fails naming the exact flag to
      pass, rather than blocking on input that will never arrive. Verified live
      (exit 1, single targeted message).
- [x] Every connection step is `not-connected -> connected -> verified`, and
      only `verified` advances. Proven live: a bogus AgentMail key is rejected
      by a real API call (403) instead of being accepted.
- [x] Steps are resumable: each asks the backend whether it is already
      satisfied first, so a re-run picks up where it stopped.
- [ ] Wizard still assumes an instance EXISTS. Fold in deploy + claim so
      `jig setup` can provision from nothing (needs phase 1).
- [ ] OpenRouter via OAuth PKCE, not a pasted key. Send the user to
      `https://openrouter.ai/auth?callback_url=<instance>/api/oauth/openrouter/callback
      &code_challenge=<c>&code_challenge_method=S256`, then exchange the returned
      code at `POST https://openrouter.ai/api/v1/auth/keys` with
      `{code, code_verifier, code_challenge_method}` for a user-controlled key.
      Docs read and contract confirmed at
      openrouter.ai/docs/guides/overview/auth/oauth. NOT yet tested.
      - Use a separate callback path: `/api/oauth/callback` already serves MCP
        OAuth and the OpenRouter flow carries no `state` to disambiguate on.
      - Localhost callbacks work on any port, so local `jig start` uses the same
        path. Headless mode (omit `callback_url`, pass `key_label`, code shown
        on screen to paste) is the fallback where no callback is reachable.
      - VERIFY THE BALANCE, not the key. A fresh account has zero credits and
        the key will authenticate while every model call fails. Reuse the
        existing `/api/v1/credits` call in `services/openrouter-credits.ts`.
      - Deep links for the dashboard, from the sha256 hex of the key:
        `openrouter.ai/keys/<hash>` and `openrouter.ai/logs?api_key_hash=<hash>`.
- [x] AgentMail is first and required. It stays a PASTED key: there is no OAuth
      for the first key. Docs read 2026-08-22, not tested.
      - `console.agentmail.to` -> API Keys -> Create New Key (`am_...`), shown
        once. `POST /api-keys` needs an existing bearer key, so it only mints
        scoped sub-keys. AgentID public-key auth does not substitute either:
        "Public-key credentials ... cannot replace an AgentMail bearer API key
        for normal REST API calls."
      - Signup is free with no credit card, so deep-link straight to the console
        API-keys page and wait for the paste.
      - Verify in two steps: `GET /auth/me` proves the key, then the existing
        `/api/settings/agentmail/test` send proves the owner address.
      - WARN about the free-tier ceiling: 3 inboxes total, and Jig spends one on
        the main inbox plus one per email-triggered jig (`createJigInbox`). A
        free-tier user gets 2 email jigs. Surface this in the wizard and make
        the over-limit failure legible instead of a raw API error.
- [ ] Composio second. After OAuth, recommend Gmail + Google Calendar +
      Telegram-or-Slack, point at dashboard.composio.dev, then re-run the
      existing discovery sweep as the verification.
- [ ] Replace `OnboardingView`'s five-cards-at-once layout with the same
      sequential steps, reading the same driver.
- [ ] Retire the `onboarding_complete` boolean in favour of wizard state.

## 3. Per-connection verification

- [x] `verify: { tool, args }` added to `ServerMeta`; `src/services/
      connection-verify.ts` implements TWO levels, which turned out better than
      the planned one: `probe` calls a configured read-only tool (proves DATA),
      `handshake` opens a live MCP connection and lists tools (proves
      CREDENTIALS, needs no config and works for every server). A failed probe
      falls back to a handshake, because a renamed tool says nothing about
      whether the user's credentials work.
- [x] `POST /api/connections/:name/verify`, admin-gated, contract registered.
- [x] One-line human summary plus pass/fail; the CLI states when a result is
      handshake-only so a credential check is never presented as a data check.
- [x] Writes through `connection-status.ts` so the wizard and the Connections
      page cannot disagree.
- [ ] Populate `meta.verify` per server. Deliberately left EMPTY: the tool name
      and its read-only annotation must be confirmed against a live connection
      first, and writing config I cannot test is how the probe silently rots.
      Everything reports `handshake` until then, which is honest.

## 4. Auto-unlock

- [ ] Store the instance password in the OS keychain: `security
      add-generic-password` on macOS, `secret-tool` on Linux, 0600 manifest
      where neither exists.
- [ ] On any 401/423 from a remote call, re-unlock and retry once.
- [ ] Never write the password to the manifest when a keychain is available.
- [ ] Document the tradeoff in `docs/operations.md`: the laptop becomes a
      long-lived credential, the volume does not.

## 5. `jig ideas`

- [ ] Generate 3-5 concrete jig ideas from the toolkits that actually verified,
      not from a static list. Fall back to `examples/` when nothing verified.
- [ ] Each idea is one command away from existing (hand it to `jig new`).

## 6. The skill and the README

- [ ] `.agents/skills/jig-setup/`, read by Claude Code, Codex, Cursor and
      OpenCode from the same directory. Thin: drive the wizard, open browser
      tabs, relay what the user must paste.
- [ ] A second skill for steady-state use: author, review the diff, approve,
      run, tail. This is where the judgment lives ("never approve a pending
      version without showing the diff first").
- [ ] Claude Code plugin manifest so `/jig-setup` exists as a slash command.
- [ ] README leads with the one line to paste. Move clone-and-build to
      `CONTRIBUTING.md`, where it belongs.

## 7. Tests

- [x] Wizard advances only on verified, never on connected
- [x] Wizard resumes mid-flight (rerun after a failed step picks up where it was)
- [x] Verifies only AFTER oauth completes, never before
- [x] Required-step failure aborts; optional-step failure continues
- [x] Zero OpenRouter balance is reported as a warning, not as healthy
- [x] Bad key rejected on the balance re-check, not trusted from the paste
- [x] FIXED a real bug found while wiring this: OpenRouter credits are cached
      for 60s, so the wizard's verify-right-after-paste read the stale pre-key
      null and reported a GOOD key as invalid. Added
      `invalidateOpenRouterCredits()` and call it wherever the key is written.
- [ ] Workspace selection refuses to proceed without an explicit pick
- [ ] Auto-unlock retries once on 423 and does not loop
- [ ] Keychain absent falls back to the 0600 file
- [ ] `verify` config present for every non-disabled server in `default.json`

## Open questions

- What does a template-button user (no clone, no CLI) get told? They cannot run
  any of this.
- RESOLVED: `railway logs -s jig --lines 400` finds the setup code fine from the
  linked dir.
- RESOLVED: `railway whoami --json` lists workspaces even with 0 projects.

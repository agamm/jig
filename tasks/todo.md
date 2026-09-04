# Composio discovery fix, agent-authored jigs, setup model probe (2026-09-03)

## Part 1: multi-part tool results
- [x] `normalizeToolResult` keeps the structured part when a response has several text parts
- [x] `searchTools` throws on a response without `results`; `discover()` throws when no statuses were seen at all
- [x] `unwrapComposioResult` tolerates a multi-part array
- [x] Tests: mcp-client (trailer, multi-structured, none), composio-unwrap (envelope pick)
- [x] Live: `discover()` finds the connected toolkits again with tools > 0 (was 0)
- [x] Version bump 0.1.128 -> 0.1.129 in both package.json
- [x] Rewrite the local `.jig/schemas/composio.json` through the real connect flow after the fix (a probe had overwritten it with the meta-tool list)

## Part 2: discovery v2
- [x] Seed candidates from the SEARCH_TOOLS description "connected the apps" line
- [x] Confirm candidates with one `MANAGE_CONNECTIONS list` call (falls back to the reported set if it fails)
- [x] Second enumeration pass with `search_strategy: "tool_search"` + bounded retry on -32000 (live: roughly 1.7x the tools of a single pass)
- [x] Header comment refresh; `test/composio-discover.test.ts` (8 tests)

## Part 4: setup model probe + fix CTA
- [x] `src/services/model-probe.ts` + `POST /api/models/probe` + contract
- [x] `shared/setup-flow.ts`: `probeMainModel`, `SetupFix`, step + summary
- [x] Dashboard: backend, StepState.fix, buttons
- [x] CLI: backend, renderer, summary lines
- [x] Tests (setup-flow: 3 new, model-probe: 4 new)
- [ ] Visual check of the Setup card CTA: NOT VERIFIED (needs an instance with a key and a gated main model; the dev API on 4173 answers 500 on /api/health, pre-existing)

## Part 3: agents write jigs
- [x] `PUT /api/jigs/:id/code` creates, typechecks, gated approve; handler extracted
- [x] `GET /api/connections/types` + `jig types` (writes to .jig/connections/ so @jig/connections/* resolves in a clone)
- [x] one push path: `jig edit <id> --file=` creates if missing (dropped the redundant `new --file`); remote-aware `jig pending`
- [x] Docs (AGENTS.md, llms.txt, skill, operations, README, SKILL.md, stale comment)
- [x] Tests (server-handlers 5, router 1, cli-push 5) + HTTP e2e against a scratch instance via a scratch remote manifest: types, edit --file create, pending, approve, run --dry-run, broken push exit 1, discard

## Review

- Composio: `COMPOSIO_SEARCH_TOOLS` now returns two text parts (JSON + a promo trailer); `normalizeToolResult` returned the raw string array and discovery read 0 toolkits. Fixed at the client level (keeps the one structured part), guarded in discovery (format changes throw instead of writing an empty schema), and discovery v2 seeds from Composio's own "connected the apps" hint, confirms with `MANAGE_CONNECTIONS list`, enumerates with both search strategies and retries -32000. Live on one account: 0 tools before, a single-strategy pass after the fix found about 2x the old schema, and v2 about 3.5x, across three toolkits the old sweep had partly missed.
- Setup now probes the main model with a one-token completion (successes cached 5 min, failures never), and a refusal shows the provider message plus "Fix on OpenRouter" / "Change main model" in the dashboard card and as printed lines in `jig setup`.
- Coding agents write jigs themselves: `jig types` pulls the instance's `.d.ts` into `.jig/connections/` (where tsconfig resolves `@jig/connections/*`), `jig edit <id> --file=` creates or updates (server typechecks; pending; `--approve` only when clean), `jig pending` works against the remote. One push command on purpose: `new --file` was added and then removed as a duplicate of `edit --file`.
- Suite: 749 pass. Root typecheck clean; dashboard `tsc --noEmit` clean (production build not run: it shares `.next` with the developer's running dev server).
- Not verified: the Setup card CTA rendered against a real gated-model account; the remote itself (needs a tag and `jig update <handle>`).

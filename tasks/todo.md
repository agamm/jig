# Codebase cleanup (2026-07-31)

A review of architecture, dead code, and duplication, followed by the fixes.
Everything below is done; the suite is green and `tsc --noEmit` is clean.

## Fixed a live bug: typed tool-parameter validation was silently dead

Generated connection modules import jig internals as `file://` URLs so they
resolve at runtime from anywhere. TypeScript cannot resolve that scheme, so
every tool degraded to `any` and `checkTypedToolCallDiagnostics` — the whole
missing-required-parameter check behind `check_jig` — had been a no-op.
`src/domain/jig-ts-options.ts` now maps the scheme back to an absolute path.
The two long-red tests in `validate.test.ts` were reporting this correctly.

## Test suite: trustworthy and hermetic

- Was reading the developer's real `jig.db` and the live `.jig/` connection
  artifacts, so results depended on which MCP servers that machine had
  connected. `test/setup.ts` (bunfig `preload`) now points DATA_DIR/META_DIR at
  a scratch tree and generates connections from frozen fixtures in
  `test/fixtures/schemas/`.
- Removed the `if (!existsSync(...)) return` guards that let connection tests
  silently no-op, and the connections-index scaffolding three files carried.
- Added `.github/workflows/ci.yml` (bun test + tsc + dashboard build). There
  was no CI running tests at all.
- `tsconfig.json` no longer type-checks gitignored runtime state; it covers
  `src/`, `shared/`, `test/` with `noUnusedLocals`/`noUnusedParameters`, which
  is what now keeps dead code out.
- Normalized three files off `vitest` onto `bun:test` and dropped the dep.

## Finished the v12 store migration

- `jig run` executed `jigs/<id>.ts` off disk while the dashboard and scheduler
  ran the approved version from SQLite. It now uses the store.
- Deleted `invalidateJigsCache()` — 12 call sites that invalidated a cache
  nothing read — and `src/discover.ts` with it.
- Deleted the `jigs/` filesystem watcher that broadcast dashboard updates for a
  directory nothing authoritative lived in.
- Deleted the legacy `jigs/` importer, `JIGS_DIR`, and the dead
  `resolveJigPath`/`getJigFilePath`/`getJigRelativePath` helpers.
- Untracked the three personal jigs in `jigs/` (they duplicated `examples/` and
  were auto-imported into every fresh clone) and gitignored the directory.

## Removed duplication

- Five hand-rolled OpenRouter calls (classify-failure, classify-reply,
  summarize-change, triggers, web search) collapsed into `config/fast-llm.ts`.
  One endpoint, one timeout policy, one failure contract.
- `run-api.ts` and `background-run.ts` no longer mirror each other; the shared
  preflight and execution live in `services/run-core.ts`.
- `server/router.ts` is a route table instead of 156 lines of regex if-chains,
  with markers for jig-id and integer validation. Verified equivalent against
  the old implementation over 247 generated paths.

## Squashed the schema (alpha — no legacy support)

Twenty incremental migrations collapsed into one baseline, along with the
55-line `migrationAlreadyApplied` introspection that existed only to let those
historical migrations replay over a fresh database. Verified against a copy of
the live production database: v20 -> v21, all data intact.

`db.test.ts` now asserts fresh and migrated databases converge, so editing
SCHEMA without appending a migration fails the suite.

## Other removals

- The orphaned `jig-gen` creator pipeline: 14 `JigEvent` variants nothing
  emitted, ~90 lines of CLI renderer for them, `loadReadOnlyTools`, and the
  always-`undefined` `emit` parameters.
- `Context`'s `allowedTools` constructor parameter (never read — tool scoping is
  per-step) and the deprecated `ctx.log()` alias. `SKILL.md` updated to
  `ctx.output()`.
- Dashboard demo scaffolding: the `Phase` toggle, the `/mock` route, and
  `mock-data.ts` — which production components were importing a real constant
  from.
- ANSI spinners written to `process.stdout` from `mcp/client.ts`, inside the
  API server process.
- `start.ts`'s typegen subprocess, redundant with the in-process regeneration
  `createApiServer` already does on boot.
- Stale docs: `plan.md`, `plan_auth.md`, `status.md`, `docs/session-summary.md`,
  `docs/superpowers/`, `tasks/plan-notifications.md`, the unreferenced
  `templates/` and `scripts/` directories.

## Hardening that fell out of the cleanup

- Inbound email replies now require the thread's reply token unconditionally;
  the `if (thread.reply_token)` grandfather clause let a token-less thread
  through on a spoofable From header alone.
- Deleting or renaming a jig now cleans up its `email_threads` rows.

## Split server.ts

1,140 -> 758 lines. The auth/onboarding/health group, the connections group, and
the jig-version lifecycle moved to `src/server/handlers/{auth,connections,versions}.ts`.
server.ts keeps `Bun.serve`, the dispatch switch, and the error envelope.

## End-to-end verification

Drove the real instance through create -> run -> edit -> run against live data:
authored a Dallas weather jig, approved it, ran it (34.2 C), asked for
Fahrenheit, reviewed the pending diff, approved, re-ran (94.6 F). `jig run` from
the CLI returned the same active version as the dashboard — before the fix it
read a file that never existed.

Two environment blockers surfaced and both failed correctly rather than silently:
apify's OAuth has expired (clean "reconnect it" error), and AgentMail is not
configured, so `ctx.email` is unavailable on this instance.

## Defects the end-to-end run surfaced, and their fixes

**Apify's dataset tool was renamed and discovery never caught up.**
`src/mcp/discover/apify.ts` steered the authoring agent to
`apify.get_actor_output` — a tool that no longer exists on the Apify MCP server
(the real one is `get-dataset-items`). It was in `includeTools` and named
throughout the build-time context prompt. With the recommended tool absent from
its available list, the agent reached for `get-actor-run` (run metadata)
instead, produced a jig with no real data, and fed only a `datasetId` and an
item count into `llm()` — which invented a confident weather report while the
run reported success. Fixed the tool name and rewrote the contract text to spell
out the two-step pattern explicitly.

**The build-time validator had no rule about reading the dataset.** It checked
call shape (right actor, `actor` not `actorId`, `input` object, required fields)
but nothing stopped "call the Actor, never read its output". Added two rules:
`call-actor` without `get-dataset-items` is an error, and `get-actor-run` is
called out as metadata rather than a substitute.

**Materialized version files could go stale.** `materializeVersion` skipped
writing when `{jigId}-{versionId}.ts` already existed, but version ids restart at
1 whenever the database is rebuilt — after `resetLocalState`, or the
corruption-recovery path. A re-created jig of the same name would then import the
OLD code. It now always writes, and `resetLocalState` wipes `RUNTIME_DIR`. Caught
by the new lifecycle test, not by inspection.

## Tests added for the refactor

The refactored modules had no direct coverage. Added 40 tests across three files:

- `test/run-lifecycle.test.ts` — automated form of the manual create/run/edit/run
  drive-through: seed, run, edit (pending does NOT change what runs), approve,
  run again, plus per-jig concurrency, dry-run, the scheduler's path through the
  same core, and `prepareRun`'s three failure modes.
- `test/fast-llm.test.ts` — the shared LLM helper's contract, which is mostly
  about how it fails. Includes the security-relevant one: the reply-approval
  classifier must fail CLOSED, so an unreachable model can never be read as
  "yes, ship the AI-written fix".
- `test/server-handlers.test.ts` — the handler modules split out of server.ts.

Each new guard was mutation-tested: reintroducing the bug it covers makes it
fail, so none of them pass vacuously.

## Maintainability pass (/agam-review) and its fixes

- `CLAUDE.md` database rules described the pre-squash migration model
  (`user_version` as a bare index, manual "test against existing DBs"). Rewritten
  for the baseline model, with the two-edits-per-schema-change rule stated.
- `test/run.test.ts` still wrote `_test_*.ts` into the real project `jigs/`
  directory. Moved to an OS temp dir, matching the other run tests.
- Finished the server.ts handler split: `handlers/jigs.ts` and `handlers/admin.ts`
  now hold the four that were left inline. 1,140 -> 620 lines, and there is one
  answer to "where does a handler live".
- Removed change-narration comments ("Before this module...", "used to exist as
  two hand-synced copies", "as this did pre-v12") in favour of forward-looking
  rationale. The history belongs in this file, not in the source.
- Deleted the dead `Token` interface left behind by the mock-data removal, and
  comments referencing the deleted `JIGS_DIR` / `DRAFT_JIGS_DIR`.
- Version 0.1.79 -> 0.1.80 in both package.json files.

### A pre-existing bug the smoke test caught

`resetLocalState` called `closeDb()` and then `storeListJigs()`, which reopens
the singleton. Unlinking the database file under that live handle left an
orphaned vnode, so every query after a reset failed with `SQLITE_IOERR` until the
process restarted — the dashboard was dead in the water after its own reset
button. Now the jig list is read before closing, and the per-row delete is gone
(removing the file is what deletes them). Regression test added and
mutation-checked.

## Not done

`src/services/agent-service.ts` is still ~2,000 lines across six
responsibilities (session store, jig lock, nine tool implementations, the agent
loop, the self-heal pass, SSE transport). Splitting it means extracting session
state first, since the tools mutate it — a multi-module change in the most
delicate file in the codebase, with only 10 tests covering its seams. It is
worth doing as a dedicated pass, not as the tail of a cleanup.

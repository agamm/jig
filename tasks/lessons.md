# Lessons

## A Mode Signal Does Not Guarantee Every Mode Attribute Exists

**What happened:** Service-mode detection was correctly broadened to activate
from Railway's environment ID before a public domain exists. MCP OAuth still
assumed `isServiceMode()` guaranteed `publicUrl()`, so the Setup page's Composio
button failed before it could produce an authorization URL. A later fix covered
OpenRouter's separate callback builder but not the sibling MCP path.

**Rule:** When broadening a mode predicate, audit every caller for attributes it
implicitly treated as guaranteed by that predicate. For hosted callback URLs,
pass the validated request origin through every OAuth implementation and test
the platform-ID-without-domain state at the HTTP boundary and callback builder.

## SQLite Migrations: Never Insert, Always Append

**What happened:** Added `authorized_senders` as migration v3 in one commit. In the next commit, inserted `credentials` as the new v3 and bumped `authorized_senders` to v4. DBs that already migrated to v3 skipped the new `credentials` migration because `user_version` was already past it.

**Rule:** New migrations ALWAYS go at the end of the `MIGRATIONS` array. Never reorder or insert before existing migrations. The `user_version` is an index — inserting shifts everything.

**Verification:** After adding a migration, test against an existing DB (not just a fresh one) to confirm the new migration runs.

## Test Scripts With Side-Effecting Modules: Prove the Guard Engaged

**What happened:** A test script for the OAuth provider set `RAILWAY_PUBLIC_DOMAIN` assuming it would trip `isServiceMode()` and suppress the browser-open in `redirectToAuthorization`. It checks `RAILWAY_ENVIRONMENT_ID`/`RAILWAY_PROJECT_ID`/`JIG_PUBLIC_URL` — not that var — so `open(url)` fired and popped dead tabs in the user's browser.

**Rule:** When a test relies on an env var/flag to neutralize a side effect (browser open, email send, network call), ASSERT the guard is active inside the test before exercising the code (e.g. `if (!isServiceMode()) throw`), or stub the side-effecting call directly. Read the guard's implementation — don't guess its trigger from the var name.

## A Required Step That Is Inconvenient Gets Guided, Not Demoted

**What happened:** Asked to make setup need no pasted tokens, I made AgentMail optional because it has no OAuth. That quietly traded away the failure-alert channel: a jig that breaks would email nobody. The user's answer was "guide via setup to set it up", not "drop it".

**Rule:** When a requirement blocks a goal, the first move is to make the requirement easier to satisfy (open the console, name the clicks, collect it in the browser where there is no terminal). Demoting it to optional changes the product's guarantees and is the user's call, not a workaround to reach for.

## Examples Ship As Active Jigs, So Validate Them Like Jigs

**What happened:** `examples/weekly-update.ts` read a `templates/` file that does not exist in the repo, and two examples imported the `workspace` connection, disabled in `servers/default.json` since 2026-06-15. `addExampleJig` writes an example straight to active with no review gate, so both would have installed a jig that could never run. The test that covered examples asserted the broken tool names, so it stayed green.

**Rule:** Run `validateJigFile` and `validateTsFile` (the same checks the runtime uses) over every example after touching one. Assert the RULE (connection is enabled in the registry, output is inside a step), never the current spelling of one example, or the test pins the bug in place.

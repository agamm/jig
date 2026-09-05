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

**Rule:** Run `validateJigFile` and `validateTsFile` (the same checks the runtime uses) over every example after touching one. Assert the RULE (connection is enabled in the registry, output is inside a step), never the current spelling of one example, or the test pins the bug in place. Examples are no longer installed (the dashboard lists them as prompts to copy), but the files remain the reference jig fed to the headless loop, so the rule still applies.

## One Job, One Command Name

**What happened:** Adding the file-push path I gave it two spellings, `jig new <id> --file=` and `jig edit <id> --file=`, both calling the same function. The repo had already collapsed `debug pull/push` into `edit --out/--file` for exactly this reason, and the user asked for no redundant CLI commands.

**Rule:** Before adding a command or flag, check whether an existing one can absorb the behavior (here: `edit --file` creates when the jig does not exist). Two names for one job cost docs, tests and agent confusion; one name with one extra sentence in the help text does not.

## A Helper Named Like a Query Can Still Write

**What happened:** "Read-only" probe scripts called `discoverTools(connection)` to list Composio's meta-tools. That helper also writes `SCHEMAS_DIR/<server>.json`, so the probes overwrote the real connection schema with the 7 meta-tools and the dashboard read the wrong tool count until the connect flow rewrote it.

**Rule:** Before calling a repo helper from a probe or test, read its body for filesystem, DB or network writes, not just its name and return type. Call the underlying primitive (`client.listTools()`) when only the read is wanted.

## "No Side Effects" From a Third Party Is a Claim, Not a Fact

**What happened:** Composio's schema says `MANAGE_CONNECTIONS action:"list"` has no side effects. Listing toolkits that were not connected returned `status: "initiated"`, which may have created pending auth requests in the user's account.

**Rule:** Probe a third-party "read" first with inputs known to be in the positive state, and only widen once the negative case is understood. Design code paths so such calls only ever receive inputs already known to be positive (here: only toolkits search already reported connected).

## A Helper Named Like A Query Can Still Write

**What happened:** "Read-only" probe scripts called `discoverTools(connection)` to list Composio's meta-tools. That helper also writes `SCHEMAS_DIR/<server>.json` as a side effect, so the probes overwrote the connection's real schema with the meta-tool list.

**Rule:** Before calling any helper from a probe, read its body for writes (files, DB, network mutations). If the function you want is "list", but the helper you found also caches to disk, call the underlying client method instead.

## Worktree Agents Must Verify Their Base Commit

**What happened:** Four parallel worktrees were created two commits behind the commit the tasks named as their base. Each agent noticed and fast-forwarded, but only because the prompt stated the base hash.

**Rule:** Always state the base commit hash in a worktree agent's prompt and ask it to confirm `git rev-parse HEAD` matches before editing; merge by cherry-pick so history stays linear.

## One Job, One CLI Command

**What happened:** `jig new <id> --file=` was added next to `jig edit <id> --file=` for creation. They were the same code path with two names, the exact duplication the repo had removed once before (`debug pull/push`).

**Rule:** Before adding a command or flag, check whether an existing one already covers the job; make it create-if-missing rather than adding a second verb.

## Verify Against The Source Of Truth, Not A Lagging View

**What happened:** A deploy created a volume through the Railway API, then verified it through the CLI's listing, which had not caught up yet, and aborted a healthy deploy as "no volume".

**Rule:** When an API call returns an identifier, that is the proof. A secondary listing is confirmation only: retry it for a bounded time and never let its lag override a success the primary call already reported.

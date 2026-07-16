# Lessons

## SQLite Migrations: Never Insert, Always Append

**What happened:** Added `authorized_senders` as migration v3 in one commit. In the next commit, inserted `credentials` as the new v3 and bumped `authorized_senders` to v4. DBs that already migrated to v3 skipped the new `credentials` migration because `user_version` was already past it.

**Rule:** New migrations ALWAYS go at the end of the `MIGRATIONS` array. Never reorder or insert before existing migrations. The `user_version` is an index — inserting shifts everything.

**Verification:** After adding a migration, test against an existing DB (not just a fresh one) to confirm the new migration runs.

## Test Scripts With Side-Effecting Modules: Prove the Guard Engaged

**What happened:** A test script for the OAuth provider set `RAILWAY_PUBLIC_DOMAIN` assuming it would trip `isServiceMode()` and suppress the browser-open in `redirectToAuthorization`. It checks `RAILWAY_ENVIRONMENT_ID`/`RAILWAY_PROJECT_ID`/`JIG_PUBLIC_URL` — not that var — so `open(url)` fired and popped dead tabs in the user's browser.

**Rule:** When a test relies on an env var/flag to neutralize a side effect (browser open, email send, network call), ASSERT the guard is active inside the test before exercising the code (e.g. `if (!isServiceMode()) throw`), or stub the side-effecting call directly. Read the guard's implementation — don't guess its trigger from the var name.

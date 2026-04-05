# Lessons

## SQLite Migrations: Never Insert, Always Append

**What happened:** Added `authorized_senders` as migration v3 in one commit. In the next commit, inserted `credentials` as the new v3 and bumped `authorized_senders` to v4. DBs that already migrated to v3 skipped the new `credentials` migration because `user_version` was already past it.

**Rule:** New migrations ALWAYS go at the end of the `MIGRATIONS` array. Never reorder or insert before existing migrations. The `user_version` is an index — inserting shifts everything.

**Verification:** After adding a migration, test against an existing DB (not just a fresh one) to confirm the new migration runs.

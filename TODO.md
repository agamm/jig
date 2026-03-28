# TODO

## High Priority

- [ ] **Full per-run isolation (Option B)** — Move spinner to AsyncLocalStorage alongside dryRun. Create per-run Spinner instances. Remove one-run-at-a-time constraint. Enables parallel jig execution on the server.
  - Files: `src/sdk/spinner.ts`, `src/sdk/llm.ts`, `src/runner.ts`, `src/server.ts`

- [ ] **`llm()` schema should accept full JSON Schema** — Current `schema` option only supports flat `Record<string, string>` types. `creator.ts` bypasses `llm()` entirely for complex schemas (`deriveSteps` calls OpenAI directly). Accept a full JSON Schema object alongside the simple format for backwards compatibility.
  - Files: `src/sdk/llm.ts`, `src/creator.ts`

- [ ] **N+1 queries in `getJigRuns`** — Fetches runs, then loops to fetch steps individually. Use a single JOIN query and group in application code.
  - Files: `src/db.ts`

- [ ] **Test coverage** — No tests for: Context step lifecycle, API route handlers, `persist()` event-to-DB mapping, creator pipeline, MCP client, dashboard polling hook.
  - Priority: Context, persist(), API routes

## Medium Priority

- [ ] **`jig_steps` table missing unique constraint** — No unique index on `(jig_id, entity, seq)`. `upsertJigSteps` does DELETE-then-INSERT non-atomically. Add unique index and wrap in transaction.
  - Files: `src/db.ts`

- [ ] **Tool schema loading is redundant** — `loadToolSchema()` in `llm.ts` reads and parses the same server JSON file per-tool. Cache parsed schemas by server name.
  - Files: `src/sdk/llm.ts`

- [ ] **`TOOL_SVC` map hardcoded in run-steps.tsx** — Tool-to-service mapping is manually maintained. Derive from the tool's `_serverName` prefix or pass from API.
  - Files: `dashboard/src/components/run-steps.tsx`

- [ ] **Cache-busting imports may leak memory** — `import(\`\${path}?_t=\${Date.now()}\`)` creates a unique module URL per run. Monitor Bun's module cache memory over sustained server operation.
  - Files: `src/runner.ts`

## Low Priority

- [ ] **`require("fs")` in db.ts** — Inconsistent with ESM usage everywhere else. Use `import { unlinkSync } from "fs"`.
  - Files: `src/db.ts`

- [ ] **`handleCancelRun` writes to `process.stderr`** — Violates "abstract all I/O" principle from CLAUDE.md. The server is not CLI glue.
  - Files: `src/server.ts`

- [ ] **`loadServerConfigs` reads from disk on every call** — No caching. Called 3+ times during a single creator pipeline. Add TTL cache or per-request cache.
  - Files: `src/mcp/config.ts`

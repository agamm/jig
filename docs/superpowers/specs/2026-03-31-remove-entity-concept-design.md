# Remove Entity/Grouped Jigs Concept

**Date:** 2026-03-31
**Status:** Approved
**Goal:** Simplify the jig model by removing the "entity" concept. Every jig is independent. The `jigs/` directory is flat.

## Current State

Jigs support a "grouped" mode where `jigs/foo/bar.ts` creates jig `foo` with entity `bar`. This adds entity resolution, selection, validation, and special-case handling across ~30 files. **Zero grouped jigs exist today** — the feature is unused infrastructure.

## Design

### 1. File Structure

**Before:** `jigs/*.ts` (single) + `jigs/<id>/<entity>.ts` (grouped)
**After:** `jigs/*.ts` only. Subdirectories are ignored by discovery.

Jig ID = filename without `.ts`. Example: `weekly-update-marketing.ts` → ID `weekly-update-marketing`.

### 2. Discovery

`discoverJigs(jigsDir)` changes from `Map<string, string[]>` to `string[]`. Globs `jigs/*.ts`, skips `_` prefixed files. No subdirectory scanning.

### 3. Path Resolution

All path functions collapse to one:

```typescript
function resolveJigPath(jigId: string): string {
  return join(JIGS_DIR, `${jigId}.ts`)
}
```

Delete: `selectJigEntity`, `resolveJigEntityOrThrow`, `getJigFilePath`, `getJigRelativePath`.

### 4. Database

- `runs.entity` column: stop reading/writing it. Leave the column in schema for backwards compat (existing rows keep their data, new rows get NULL). No migration needed.
- `step_cache`: simplify unique index to `(jig_id, code_hash)`. Drop entity from key.
- All query functions lose their `entity` parameter.

### 5. Shared API Types (`shared/api.ts`)

Remove from `JigData`: `sourceId`, `entity`, `groupId`, `groupName`, `grouped`, `entityCount`, `entities`, `JigEntity` interface.

The `id` field is the jig ID directly (no `::` encoding).

Remove `entity` from: `RunStatus`, `RunDetail`, `StartRunResponse`, `StartAgentResponse`.

### 6. Server Routes

All routes lose `?entity=` query param and `{entity}` body field:

- `GET /api/jigs/:id` — returns single jig
- `POST /api/jigs/:id/run` — body: `{params?, dryRun?}`
- `POST /api/jigs/:id/steps` — no body needed (was only for entity)
- `POST /api/jigs/:id/trigger` — body: `{trigger}`
- `DELETE /api/jigs/:id` — deletes the jig file
- `GET/POST /api/jigs/:id/versions[/:sha]` — no entity param
- `POST /api/agent` — body: `{instruction, jigId?}` (no entity)

### 7. CLI

- `jig run <name>` runs the jig. No entity prompt, no "all" mode.
- `jig edit <name>` edits the jig. No entity argument.
- Remove `entity-list` and `entity-required` event types.

### 8. Dashboard

- Remove entity from all API fetch calls in `lib/api.ts`
- Remove entity passing from hooks (`use-jig-run`, `use-trigger-save`, `use-agent`)
- Remove `groupName` / entity display from `jig-list.tsx`
- Remove entity from `jig-detail-pane.tsx`, `jig-versions.tsx`
- `jig-tool-approval.ts` loses entity param

### 9. Services

- `run-api.ts`: `startJigRun` no longer resolves entity
- `run-store.ts`: `RunRecord` loses `entity` field
- `agent-service.ts`: `AgentSession` loses `entity`, tool descriptions drop entity param
- `jig-api.ts`: `buildJigResponse` simplified — no entity branching
- `jig-versioning.ts`: all functions lose entity param
- `jig-writer.ts`: `writeJigSource` options lose entity
- `jig-writing-prompt.ts`: remove grouped jig import path instructions

### 10. Tests

- `test/jig-source.test.ts`: remove entity-related test cases, keep path traversal tests
- `test/discover.test.ts`: simplify to test flat discovery only
- Other tests: remove entity from any setup/assertions

## What Does NOT Change

- `isValidJigId` validation stays (still need to validate filenames)
- Run history in DB preserved (entity column just goes unused)
- Import path for jigs stays `../src/index.js` (all jigs are at same depth)
- Jig definition API (`jig()`, `handler`, `params`, `trigger`, `tools`) unchanged

## Blast Radius

~30 files touched, ~500-700 lines removed, ~50 lines added. Almost entirely deletion and parameter removal.

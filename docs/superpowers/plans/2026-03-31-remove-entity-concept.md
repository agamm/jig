# Remove Entity Concept — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the "entity" / grouped jigs concept so every jig is an independent flat file in `jigs/`.

**Architecture:** Bottom-up removal — shared types first, then domain/DB, then services, then server routes, then CLI, then dashboard. Each task produces a compiling, test-passing codebase.

**Tech Stack:** TypeScript, Bun, SQLite (bun:sqlite), Next.js 16, React

**Key principle:** This is almost entirely deletion. When in doubt, delete more.

---

### Task 1: Simplify shared API types

**Files:**
- Modify: `shared/api.ts`

- [ ] **Step 1: Remove entity fields from shared types**

In `shared/api.ts`, make these changes:

1. Delete the `JigEntity` interface entirely (around line 35-39)
2. From `JigData`, remove: `sourceId`, `entity`, `groupId`, `groupName`, `grouped`, `entityCount`, `entities`
3. From `RunStatus`, remove: `entity`
4. From `RunDetail`, remove: `entity`
5. From `StartRunResponse`, remove: `entity`
6. From `StartAgentResponse`, remove: `entity` (if present)

- [ ] **Step 2: Verify no compile errors in shared**

Run: `bun build shared/api.ts --no-bundle 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add shared/api.ts
git commit -m "Remove entity fields from shared API types"
```

---

### Task 2: Simplify discovery to flat file list

**Files:**
- Modify: `src/discover.ts`
- Modify: `test/discover.test.ts`

- [ ] **Step 1: Read current discover.ts**

Read the full file to understand the current implementation.

- [ ] **Step 2: Simplify discoverJigs to return string[]**

Change `discoverJigs(jigsDir: string): Map<string, string[]>` to return `string[]` — just jig IDs from `*.ts` files directly in the directory (no subdirectory scanning). Skip files starting with `_`.

The cache (`_cache`, `_cacheTime`, `invalidateJigsCache`) should still work the same way but store `string[]` instead of `Map`.

- [ ] **Step 3: Update tests**

In `test/discover.test.ts`, update all assertions:
- Single jig: expect the ID to appear in the array
- Remove all grouped jig tests (entity arrays)
- If tests create subdirectory fixtures, remove those

- [ ] **Step 4: Run tests**

Run: `bun test test/discover.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/discover.ts test/discover.test.ts
git commit -m "Simplify jig discovery to flat file list"
```

---

### Task 3: Simplify domain layer (jig-source.ts)

**Files:**
- Modify: `src/domain/jig-source.ts`
- Modify: `test/jig-source.test.ts`

- [ ] **Step 1: Gut jig-source.ts**

1. Delete `selectJigEntity`, `JigEntitySelection`, `JigEntitySelectionOptions` types, and `resolveJigEntityOrThrow` entirely
2. Simplify `resolveJigPath(jigId: string)` — remove the optional `entity` param. Body: `return join(JIGS_DIR, \`${jigId}.ts\`)`
3. Simplify `getJigFilePath(id: string)` — remove entity param. Just check if `join(JIGS_DIR, \`${id}.ts\`)` exists, return it or null. No subdirectory fallback.
4. Simplify `getJigRelativePath(jigId: string)` — remove entity param. Return `\`${jigId}.ts\`` after validation.
5. Remove the `ApiError` import (no longer needed after removing `resolveJigEntityOrThrow`)
6. Remove `discoverJigs` import (no longer needed for fallback in `getJigFilePath`)

- [ ] **Step 2: Update tests**

In `test/jig-source.test.ts`:
- Delete the entire `selectJigEntity` test suite
- Update `getJigFilePath` tests to remove entity parameter
- Keep path traversal rejection tests (still relevant)

- [ ] **Step 3: Run tests**

Run: `bun test test/jig-source.test.ts`

- [ ] **Step 4: Commit**

```bash
git add src/domain/jig-source.ts test/jig-source.test.ts
git commit -m "Remove entity from domain layer"
```

---

### Task 4: Simplify database layer

**Files:**
- Modify: `src/db.ts`

- [ ] **Step 1: Remove entity from all function signatures**

1. `insertRun(jigId, params?)` — remove `entity` param; pass `null` for the SQL column (leave column in schema)
2. `getJigRuns(jigId, limit?)` — remove `entity` param; remove the entity-conditional query branch
3. `getLastRun(jigId)` — remove `entity` param; remove entity-conditional query
4. `getStepCache(jigId, codeHash)` — remove `entity` param; query with `entity IS NULL`
5. `setStepCache(jigId, codeHash, steps)` — remove `entity` param; insert with `NULL`
6. `clearStepCache(jigId)` — remove `entity` param; delete where `jig_id = ?` only

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: some failures from callers passing entity — that's OK, we fix those in subsequent tasks.

- [ ] **Step 3: Commit**

```bash
git add src/db.ts
git commit -m "Remove entity from database functions"
```

---

### Task 5: Simplify derive-steps.ts

**Files:**
- Modify: `src/derive-steps.ts`

- [ ] **Step 1: Remove entity parameter**

The `deriveSteps` function signature should lose its `entity` parameter. Update calls to `getStepCache` and `setStepCache` to match the new signatures (no entity).

- [ ] **Step 2: Commit**

```bash
git add src/derive-steps.ts
git commit -m "Remove entity from step derivation"
```

---

### Task 6: Simplify run-store and run-api

**Files:**
- Modify: `src/services/run-store.ts`
- Modify: `src/services/run-api.ts`

- [ ] **Step 1: Remove entity from RunRecord and startTrackedRun**

In `run-store.ts`:
1. Remove `entity: string | null` from `RunRecord` type
2. Remove `entity` param from `startTrackedRun(runId, jigId, dryRun)`
3. Remove `entity` from the object created in `startTrackedRun`
4. Remove `entity: run.entity` from `toRunStatus`

- [ ] **Step 2: Simplify startJigRun in run-api.ts**

1. Remove `requestedEntity` extraction from body
2. Remove `resolveJigEntityOrThrow` call — replace with: check `discovered.has(id)`, then `resolveJigPath(id)` directly
3. Remove `resolveJigEntityOrThrow` import; update `resolveJigPath` import to the new 1-arg version
4. Remove `entity` from `insertRun`, `startTrackedRun`, and `StartRunResponse`
5. Remove `entity` from `getRunDetail` return object

- [ ] **Step 3: Run tests**

Run: `bun test`

- [ ] **Step 4: Commit**

```bash
git add src/services/run-store.ts src/services/run-api.ts
git commit -m "Remove entity from run tracking"
```

---

### Task 7: Simplify jig-api.ts (buildJigResponse)

**Files:**
- Modify: `src/services/jig-api.ts`

- [ ] **Step 1: Read current file**

- [ ] **Step 2: Simplify buildJigResponse**

1. Change `discoverAllJigs()` to return the new `string[]` from discover.ts (it likely wraps the cached result)
2. `buildJigResponse(id, runLimit, includeCode?)` — remove `entities` and `selectedEntity` params
3. Remove all entity-related fields from the response: `sourceId`, `entity`, `groupId`, `groupName`, `grouped`, `entityCount`, `entities`
4. The `id` field is just `id` (no `::` encoding)
5. `name` is `prettifyId(id)`
6. `deriveStatus(jigId)` — remove entity param
7. Remove `getJigRuns` entity param usage
8. Use simplified `getJigFilePath(id)` and `resolveJigPath(id)`

- [ ] **Step 3: Run tests**

Run: `bun test`

- [ ] **Step 4: Commit**

```bash
git add src/services/jig-api.ts
git commit -m "Remove entity from jig API responses"
```

---

### Task 8: Simplify jig-versioning, jig-writer, jig-writing-prompt

**Files:**
- Modify: `src/services/jig-versioning.ts`
- Modify: `src/services/jig-writer.ts`
- Modify: `src/services/jig-writing-prompt.ts`

- [ ] **Step 1: Remove entity from jig-versioning.ts**

All three functions (`listJigVersions`, `getJigVersionDetail`, `restoreJigVersion`) lose their `entity` param. Update calls to `getJigRelativePath(jigId)`, `getJigFilePath(jigId)`, `resolveJigPath(jigId)`, and `writeJigSource` (no entity in options).

- [ ] **Step 2: Remove entity from jig-writer.ts**

Remove `entity` from options type and function body. Remove the directory creation branch for grouped jigs. Simplify `relPath` to just `\`${jigId}.ts\``. Update `clearStepCache(jigId)` call.

- [ ] **Step 3: Remove entity from jig-writing-prompt.ts**

Remove `entity` from `AgentPromptInput` type. Remove any grouped jig import path instructions (all jigs use `"../src/index.js"`).

- [ ] **Step 4: Run tests**

Run: `bun test`

- [ ] **Step 5: Commit**

```bash
git add src/services/jig-versioning.ts src/services/jig-writer.ts src/services/jig-writing-prompt.ts
git commit -m "Remove entity from versioning, writer, and prompts"
```

---

### Task 9: Simplify agent-service.ts

**Files:**
- Modify: `src/services/agent-service.ts`

- [ ] **Step 1: Remove entity from agent session and tools**

1. Remove `entity?: string` from `AgentSession` type
2. Remove entity parameters from tool definitions (lines 64, 79, 95 — delete the entity property from each tool's parameters schema)
3. Simplify `toolReadJigFile`, `toolWriteJigFile`, `toolCheckJig` — remove entity logic, use `resolveJigPath(jigId)` directly
4. Simplify `buildAgentSystemPrompt(jigId?)` — remove entity param
5. Simplify `startAgentSession` — remove entity from body extraction and session init
6. Remove entity from tool descriptions

- [ ] **Step 2: Run tests**

Run: `bun test`

- [ ] **Step 3: Commit**

```bash
git add src/services/agent-service.ts
git commit -m "Remove entity from agent service"
```

---

### Task 10: Simplify server.ts routes

**Files:**
- Modify: `src/server.ts`

- [ ] **Step 1: Read current file**

- [ ] **Step 2: Remove entity handling from all routes**

1. `resolveJigRequest(id)` — simplify to just check `discovered.has(id)` (returns void or throws). No entity resolution. Delete the function entirely if it becomes trivial — inline the check.
2. All route handlers: remove `url.searchParams.get("entity")` and `body?.entity` extraction
3. `handleGetSteps` — remove entity from subprocess script args
4. `handleUpdateTrigger` — remove entity param
5. `handleDeleteJig` — simplify to just delete the single file (no entity branching, no directory cleanup)
6. `handleGetVersions`, `handleGetVersionCode`, `handleRestoreVersion` — remove entity params
7. `listJigs` route: iterate over `string[]` from discovery, call `buildJigResponse(id, ...)` for each
8. `getJig` route: just call `buildJigResponse(route.params.id, ...)`
9. Remove `selectJigEntity` / `resolveJigEntityOrThrow` import
10. Remove unused imports that were only needed for entity logic

- [ ] **Step 3: Run all tests**

Run: `bun test`
Expected: ALL 118+ tests pass

- [ ] **Step 4: Commit**

```bash
git add src/server.ts
git commit -m "Remove entity from server routes"
```

---

### Task 11: Simplify CLI

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/creator.ts`

- [ ] **Step 1: Read both files**

- [ ] **Step 2: Simplify cli.ts**

1. `handleRun(name, io)` — remove entity param and all entity selection logic (entity-list events, "all" mode, entity prompts). Just discover jigs, check the name exists, run it.
2. `agentCommand(instruction, jigId?)` — remove entity param
3. Edit command: remove entity argument, just pass jigId
4. `runJigFile(jigPath, params, io, opts)` — remove entity from opts; update `insertRun` call
5. Remove `entity-list` event handling
6. Remove `"jig run <name> <entity>"` from help text

- [ ] **Step 3: Simplify creator.ts**

1. `editJig(name, instruction, io)` — remove entity param and all entity selection/validation logic
2. Remove `entity-list` and `entity-required` event types from `JigEvent`
3. Simplify path construction — always `resolveJigPath(name)`
4. Remove entity from `writeJigSource` calls
5. `dryRunAndReview` / `dryRunJig` — remove entity params

- [ ] **Step 4: Run tests**

Run: `bun test`

- [ ] **Step 5: Commit**

```bash
git add src/cli.ts src/creator.ts
git commit -m "Remove entity from CLI and creator"
```

---

### Task 12: Simplify dashboard types and API client

**Files:**
- Modify: `dashboard/src/types/jig.ts`
- Modify: `dashboard/src/lib/api.ts`

- [ ] **Step 1: Simplify dashboard types**

In `dashboard/src/types/jig.ts`:
- Remove `JigEntity` / `ApiJigEntity` imports and type aliases
- Remove any entity-related type references

- [ ] **Step 2: Remove entity from API client**

In `dashboard/src/lib/api.ts`, remove entity parameter from all functions:
- `fetchJig(jigId)` — remove entity query param
- `deleteJig(jigId)` — remove entity query param
- `fetchJigSteps(jigId)` — remove entity from body
- `updateJigTrigger(jigId, trigger)` — remove entity from body
- `startAgentSession(instruction, jigId?)` — remove entity from body
- `startJigRun(jigId, opts)` — remove entity from payload
- `fetchJigVersions(jigId)` — remove entity query param
- `fetchJigVersionDetail(jigId, sha)` — remove entity query param
- `restoreJigVersion(jigId, sha)` — remove entity query param

- [ ] **Step 3: Commit**

```bash
cd dashboard && git add src/types/jig.ts src/lib/api.ts
git commit -m "Remove entity from dashboard types and API client"
```

---

### Task 13: Simplify dashboard hooks

**Files:**
- Modify: `dashboard/src/hooks/use-jig-run.ts`
- Modify: `dashboard/src/hooks/use-trigger-save.ts`
- Modify: `dashboard/src/lib/jig-tool-approval.ts`

- [ ] **Step 1: Simplify use-jig-run.ts**

1. `matchesTarget(data, jigId)` — remove entity comparison
2. Hook function: remove entity param, remove from all API calls
3. `startRun` callback: remove entity from `startJigRun` payload

- [ ] **Step 2: Simplify use-trigger-save.ts**

Remove entity param from `useTriggerSave(jigId, serverTrigger)`. Remove from `updateJigTrigger` call.

- [ ] **Step 3: Simplify jig-tool-approval.ts**

1. `getApprovalKey(jigId, signature)` — remove entity from key (just `\`${jigId}::${signature}\``)
2. `useJigToolApproval(jigId, tools)` — remove entity param and from all internal calls

- [ ] **Step 4: Commit**

```bash
cd dashboard && git add src/hooks/use-jig-run.ts src/hooks/use-trigger-save.ts src/lib/jig-tool-approval.ts
git commit -m "Remove entity from dashboard hooks"
```

---

### Task 14: Simplify dashboard components

**Files:**
- Modify: `dashboard/src/components/jig-detail-pane.tsx`
- Modify: `dashboard/src/components/jig-list.tsx`
- Modify: `dashboard/src/components/jig-versions.tsx`
- Modify: `dashboard/src/components/dashboard-shell.tsx`
- Modify: `dashboard/src/components/create-jig-pane.tsx`

- [ ] **Step 1: Simplify jig-detail-pane.tsx**

1. Remove `const entity = jig.entity ?? null` and all uses of `entity`
2. `useTriggerSave(jigId, jig.settings.trigger)` — no entity
3. `useJigToolApproval(jigId, tools)` — no entity
4. `useJigRun(jigId)` — no entity
5. `fetchJigSteps(jigId)` — no entity
6. `agent.startSession(input, jigId)` — no entity
7. `deleteJig(jigId)` — no entity
8. `const jigId = jig.id` — no more `sourceId` fallback
9. Delete message: simplify to just `jig.name`

- [ ] **Step 2: Simplify jig-list.tsx**

Remove `groupName` display logic — just show `jig.name`.

- [ ] **Step 3: Simplify jig-versions.tsx**

Remove entity from `fetchJigVersions(jigId)`, `fetchJigVersionDetail(jigId, sha)`, `restoreJigVersion(jigId, sha)`.

- [ ] **Step 4: Simplify dashboard-shell.tsx**

1. Remove entity from `fetchJig(currentJig.id)` calls (line 214 area)
2. Remove `sourceId` usage — just use `jig.id`

- [ ] **Step 5: Simplify create-jig-pane.tsx**

Remove entity from agent session start call if present.

- [ ] **Step 6: Typecheck dashboard**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean

- [ ] **Step 7: Commit**

```bash
cd dashboard && git add src/components/
git commit -m "Remove entity from dashboard components"
```

---

### Task 15: Final verification and cleanup

**Files:**
- All files

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: all tests pass

- [ ] **Step 2: Typecheck dashboard**

Run: `cd dashboard && npx tsc --noEmit`
Expected: clean

- [ ] **Step 3: Grep for leftover entity references**

Run: `grep -rn "entity" src/ shared/ dashboard/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules | grep -v ".d.ts"`

Review any remaining references. Database column definitions and SQL schema are OK to keep (backwards compat). Any functional entity logic should be gone.

- [ ] **Step 4: Grep for leftover sourceId and groupName references**

Run: `grep -rn "sourceId\|groupName\|groupId\|entityCount\|JigEntity\|isGroupedChild" src/ shared/ dashboard/src/ --include="*.ts" --include="*.tsx" | grep -v node_modules`

Expected: no results.

- [ ] **Step 5: Final commit**

```bash
git add -A
git commit -m "Remove entity/grouped jigs concept — flat jig directory"
```

# Steps, Editing, and Triggers — Design Spec

## Problem

The dashboard shows empty steps for jigs, has no way to edit existing jigs, and allows jigs without triggers. External code edits bypass validation.

## Design

Four features that share infrastructure: LLM-derived steps, external change detection, jig editing via ReviewPane, and required triggers.

---

## 1. Step Derivation via LLM

### When
Only during `jig new` and `jig edit` (creator pipeline). After code is generated and validated, an LLM call extracts steps from the final code.

### Storage
New tables in SQLite (`src/db.ts`):

```sql
CREATE TABLE jig_steps (
  jig_id TEXT NOT NULL,
  entity TEXT,              -- NULL for single-instance (consistent with runs table)
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  cost_hint TEXT,
  PRIMARY KEY (jig_id, COALESCE(entity, ''), seq)
);

CREATE TABLE jig_meta (
  jig_id TEXT NOT NULL,
  entity TEXT,              -- NULL for single-instance (consistent with runs table)
  code_hash TEXT NOT NULL,  -- SHA-256 via Bun.CryptoHasher
  steps_derived_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (jig_id, COALESCE(entity, ''))
);
```

**Entity convention:** Uses `NULL` for single-instance jigs, consistent with the existing `runs` table. Primary keys use `COALESCE(entity, '')` to handle NULL in composite keys.

**Cleanup:** On each `GET /api/jigs` request, after `discoverJigs()`, delete rows from `jig_steps` and `jig_meta` where `jig_id` is no longer in the discovered set. This is cheap (one DELETE per request) and prevents orphaned data.

### Step derivation function

```typescript
// In src/creator.ts
async function deriveSteps(code: string, jigId: string, entity?: string): Promise<void>
```

- Calls `llm()` with the final code + prompt to extract steps as `[{ name, description, costHint? }]`
- On LLM failure (malformed JSON, timeout), logs a warning and skips — step derivation is enhancement, not blocking. The jig is still saved successfully, steps just remain empty.
- Saves to `jig_steps` table + SHA-256 hash of code to `jig_meta`

### API change
`buildJigResponse()` in `server.ts`:
- Queries `jig_steps` for the jig and transforms to dashboard format: `{ num: seq, name, desc: description, cost: cost_hint }` (matching the existing `Jig["steps"]` type)
- Queries `jig_meta` for the code hash

---

## 2. External Change Detection

### Design
On each API request for a jig, compute SHA-256 of the current file content and compare against `jig_meta.code_hash`:

- **Match**: steps are fresh, show normally
- **Mismatch** (or no `jig_meta` entry): add `stale: true` to API response

Dashboard type `Jig` gets `stale?: boolean` in `dashboard/src/types/jig.ts`.

JigDetailPane shows a warning banner when `stale` is true:
> "Code changed outside the dashboard. Steps may be outdated. [Re-compile]"

### Re-compile endpoint
```
POST /api/jigs/:id/recompile  { entity?: string }
→ { ok: true, steps: [...] }
```

This does NOT dry-run the jig (the user edited the file manually, presumably testing it themselves). It only:
1. Reads the current file
2. Runs TypeScript validation (compiler API)
3. Re-derives steps via LLM
4. Updates `jig_meta.code_hash` and `jig_steps`

---

## 3. Jig Editing via ReviewPane

### UX Flow
1. User clicks "Edit" button on JigDetailPane
2. Dashboard saves original code in memory (for discard/rollback)
3. Switches to ReviewPane with:
   - Current jig's steps and code pre-loaded
   - Banner: "Editing — {jig name}" (instead of "Draft — not compiled yet")
   - "Edit with AI" input active
4. User types instruction (e.g., "add CC to my manager")
5. Dashboard calls `POST /api/jigs/:id/edit`
6. ReviewPane shows pipeline progress: Plan → Select tools → Probe → Generate → Validate → Dry Run
7. On completion: file is overwritten, steps re-derived, ReviewPane shows updated code
8. User clicks "Done" to return to JigDetailPane, or "Discard" to restore the original code from the in-memory backup

### Discard/rollback
The original file content is saved in React state before the edit starts. "Discard" writes the original content back via `POST /api/jigs/:id/recompile` (which re-validates and re-derives steps). No file backup on disk — the in-memory copy is sufficient since edits are short-lived interactive sessions.

### Concurrency
The edit endpoint checks for an in-flight edit (in-memory flag per jig ID). If one is already running, returns `409 Conflict`. The flag is cleared on completion or error. Server restarts clear all flags (acceptable — the client poll will time out after 2 minutes and show an error).

### Wiring
- `DashboardShell`: Edit button sets `reviewMode = true` (already exists)
- `ReviewPane` gets `isEditing?: boolean` and `jigId?: string` props
- When `isEditing`, banner text changes and "Compile & Save" becomes "Done"

### New API endpoint
```
POST /api/jigs/:id/edit  { instruction: string, entity?: string }
→ { editId: string } (async — poll for completion)
```

Validates jig exists synchronously (404 if not found), checks for concurrent edits (409 if busy), then starts the async pipeline.

This calls `editJig(name, entity, instruction, io)` from `src/creator.ts`. The API wraps it with a `JigIO` that captures events for pipeline progress.

### Pipeline progress
The edit stores progress events in memory (keyed by editId). Dashboard polls `GET /api/jigs/:id/edit-status?editId=...`:

```typescript
{
  status: "planning" | "selecting-tools" | "probing" | "generating" | "validating" | "dry-running" | "done" | "error",
  message?: string
}
```

On server restart, all in-memory progress is lost. Client poll times out after 2 minutes and shows an error — user can retry.

---

## 4. Required Trigger

### Type change
`src/sdk/jig.ts`: Change `trigger?: JigTrigger` to `trigger: JigTrigger` (required).

### Validation
`src/validate.ts`: Return error if trigger is missing. Error message: "Trigger is required. Use `{ type: \"manual\" }` for manually-triggered jigs."

### Creator default
When the LLM generates code without a trigger, the creator pipeline adds `trigger: { type: "manual" }` before writing to disk.

### Existing jigs
Validation only applies during `jig new`, `jig edit`, and `recompile`. Existing jigs on disk are not scanned or modified at startup. They continue to work — the `run()` function doesn't check for triggers (that's the scheduler's job, v0.5). When the user edits a triggerless jig, the validation will flag it and the creator will inject `{ type: "manual" }`.

### Dashboard
ReviewPane's "Compile & Save" button is disabled if trigger is empty, with tooltip: "Set a trigger first".

---

## Files to Modify

| File | Change |
|------|--------|
| `src/db.ts` | Add `jig_steps` and `jig_meta` tables + CRUD functions + cleanup |
| `src/server.ts` | Read steps from SQLite, stale detection, new endpoints (edit, recompile, edit-status) |
| `src/creator.ts` | Add `deriveSteps()` after code generation, call in create + edit flows |
| `src/validate.ts` | Make trigger required |
| `src/sdk/jig.ts` | Change `trigger?` to `trigger` |
| `dashboard/src/types/jig.ts` | Add `stale?: boolean` to `Jig` type |
| `dashboard/src/components/jig-detail-pane.tsx` | Stale warning banner, wire Edit button to reviewMode |
| `dashboard/src/components/review-pane.tsx` | `isEditing` prop, wire "Edit with AI" to API, pipeline progress, discard |
| `dashboard/src/components/dashboard-shell.tsx` | Wire Edit button → reviewMode, store original code for discard |
| `test/validate.test.ts` | Update tests for required trigger |

## Verification

1. `bun test` — all tests pass (validate tests updated for required trigger)
2. `jig new "..."` — creates jig with steps derived and saved to SQLite
3. Dashboard shows steps in JigDetailPane (not empty)
4. Edit button → ReviewPane → "Edit with AI" → pipeline progress → saves updated code + steps
5. "Discard" after edit → restores original code
6. External file edit → dashboard shows stale warning → Re-compile works
7. Delete a jig file → next API request cleans up orphaned steps/meta
8. Concurrent edit attempts → 409 Conflict
9. Grouped jig edit (with entity) → correct entity passed through
10. Jig without trigger → validation error → creator defaults to manual

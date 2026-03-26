# Steps, Editing, and Triggers — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Derive steps from jig code via LLM, enable jig editing through the dashboard, make triggers required, and detect external file changes.

**Architecture:** The creator pipeline (`src/creator.ts`) gets a new `deriveSteps()` stage that runs after code generation. Steps and file hashes are cached in SQLite. The API server gains edit/recompile endpoints. The dashboard's ReviewPane is reused for editing existing jigs. Triggers become required with `manual` as default.

**Tech Stack:** Bun, SQLite (`bun:sqlite`), TypeScript compiler API, OpenRouter LLM, Next.js 16, React 19

**Spec:** `docs/superpowers/specs/2026-03-26-steps-editing-triggers-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/db.ts` | Modify | Add `jig_steps` + `jig_meta` tables, CRUD functions, cleanup |
| `src/creator.ts` | Modify | Add `deriveSteps()` after code generation in create + edit flows |
| `src/validate.ts` | Modify | Make trigger required (line 36) |
| `src/sdk/jig.ts` | Modify | `trigger?: JigTrigger` → `trigger: JigTrigger` (line 21) |
| `src/server.ts` | Modify | Read steps from SQLite, stale detection, new endpoints |
| `dashboard/src/types/jig.ts` | Modify | Add `stale?: boolean` to `Jig` type |
| `dashboard/src/components/jig-detail-pane.tsx` | Modify | Stale banner, wire Edit → reviewMode |
| `dashboard/src/components/review-pane.tsx` | Modify | `isEditing` prop, wire to API, progress |
| `dashboard/src/components/dashboard-shell.tsx` | Modify | Wire Edit button, store original code for discard |
| `test/db.test.ts` | Modify | Tests for new tables |
| `test/validate.test.ts` | Modify | Update for required trigger |

---

### Task 1: Required Trigger — SDK + Validation

**Files:**
- Modify: `src/sdk/jig.ts:20-24`
- Modify: `src/validate.ts:34-37`
- Modify: `test/validate.test.ts`
- Modify: `jigs/weekly-update.ts` (already has trigger — just verify)

- [ ] **Step 1: Update JigOptions type**

In `src/sdk/jig.ts`, line 21, change `trigger?: JigTrigger` to `trigger: JigTrigger`.

- [ ] **Step 2: Make validate.ts reject missing trigger**

In `src/validate.ts`, replace line 36 (`if (trigger === undefined) return []`) with:
```typescript
if (trigger === undefined) {
  return [{ field: "trigger", message: 'Trigger is required. Use { type: "manual" } for manually-triggered jigs.' }]
}
```

- [ ] **Step 3: Update validate tests**

In `test/validate.test.ts`, change the test "accepts a jig without trigger (optional)" to expect failure:
```typescript
it("rejects a jig without trigger", () => {
  const result = validateDefinitionObject({
    name: "no-trigger",
    options: { tools: [] },
    handler: async () => {},
  })
  expect(result.ok).toBe(false)
  expect(result.errors[0].field).toBe("trigger")
})
```

Add test for manual trigger:
```typescript
it("accepts manual trigger (the default)", () => {
  const result = validateDefinitionObject({
    name: "manual-jig",
    options: { trigger: { type: "manual" }, tools: [] },
    handler: async () => {},
  })
  expect(result.ok).toBe(true)
})
```

- [ ] **Step 4: Run tests**

Run: `bun test test/validate.test.ts`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/sdk/jig.ts src/validate.ts test/validate.test.ts
git commit -m "Make trigger required on JigOptions, default manual"
```

---

### Task 2: SQLite — jig_steps + jig_meta Tables

**Files:**
- Modify: `src/db.ts` (schema at lines 46-75, add tables + functions after line 212)
- Modify: `test/db.test.ts`

- [ ] **Step 1: Write failing tests for jig_steps and jig_meta**

Add to `test/db.test.ts`:
```typescript
import {
  // ... existing imports ...
  upsertJigSteps, getJigSteps, upsertJigMeta, getJigMeta, cleanupOrphanedMeta,
} from "../src/db.js"

describe("jig_steps", () => {
  it("upserts and retrieves steps for a jig", () => {
    const steps = [
      { name: "Search emails", description: "gmail.search(query)", costHint: null },
      { name: "Generate draft", description: "llm('Write email')", costHint: "$0.003" },
    ]
    upsertJigSteps("weekly-update", null, steps)
    const result = getJigSteps("weekly-update", null)
    expect(result).toHaveLength(2)
    expect(result[0].name).toBe("Search emails")
    expect(result[1].cost_hint).toBe("$0.003")
  })

  it("replaces steps on re-upsert", () => {
    upsertJigSteps("test", null, [{ name: "A", description: "a", costHint: null }])
    upsertJigSteps("test", null, [{ name: "B", description: "b", costHint: null }])
    const result = getJigSteps("test", null)
    expect(result).toHaveLength(1)
    expect(result[0].name).toBe("B")
  })

  it("handles entity-scoped steps", () => {
    upsertJigSteps("invoice", "acme", [{ name: "Read timesheet", description: "drive.read()", costHint: null }])
    upsertJigSteps("invoice", "globex", [{ name: "Read timesheet", description: "drive.read()", costHint: null }])
    expect(getJigSteps("invoice", "acme")).toHaveLength(1)
    expect(getJigSteps("invoice", "globex")).toHaveLength(1)
    expect(getJigSteps("invoice", null)).toHaveLength(0)
  })
})

describe("jig_meta", () => {
  it("upserts and retrieves meta", () => {
    upsertJigMeta("weekly-update", null, "abc123")
    const meta = getJigMeta("weekly-update", null)
    expect(meta).not.toBeNull()
    expect(meta!.code_hash).toBe("abc123")
  })

  it("cleans up orphaned meta", () => {
    upsertJigMeta("exists", null, "hash1")
    upsertJigMeta("deleted", null, "hash2")
    upsertJigSteps("deleted", null, [{ name: "X", description: "x", costHint: null }])
    cleanupOrphanedMeta(new Set(["exists"]))
    expect(getJigMeta("exists", null)).not.toBeNull()
    expect(getJigMeta("deleted", null)).toBeNull()
    expect(getJigSteps("deleted", null)).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test test/db.test.ts`
Expected: FAIL — functions not defined

- [ ] **Step 3: Add tables to schema**

In `src/db.ts`, append to the `SCHEMA` constant (after the `run_steps` indexes, before the closing backtick):
```sql
CREATE TABLE IF NOT EXISTS jig_steps (
  jig_id TEXT NOT NULL,
  entity TEXT,
  seq INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  cost_hint TEXT
);
CREATE INDEX IF NOT EXISTS idx_jig_steps_jig ON jig_steps(jig_id, entity);

CREATE TABLE IF NOT EXISTS jig_meta (
  jig_id TEXT NOT NULL,
  entity TEXT,
  code_hash TEXT NOT NULL,
  steps_derived_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_jig_meta_jig ON jig_meta(jig_id, COALESCE(entity, ''));
```

- [ ] **Step 4: Add types**

After `StepRow` type, add:
```typescript
export interface JigStepRow {
  jig_id: string
  entity: string | null
  seq: number
  name: string
  description: string
  cost_hint: string | null
}

export interface JigMetaRow {
  jig_id: string
  entity: string | null
  code_hash: string
  steps_derived_at: string
}
```

- [ ] **Step 5: Add CRUD functions**

After `completeStep()`, add:
```typescript
export function upsertJigSteps(
  jigId: string,
  entity: string | null,
  steps: { name: string; description: string; costHint: string | null }[]
): void {
  const db = openDb()
  db.prepare(`DELETE FROM jig_steps WHERE jig_id = ? AND entity IS ?`).run(jigId, entity)
  const stmt = db.prepare(`INSERT INTO jig_steps (jig_id, entity, seq, name, description, cost_hint) VALUES (?, ?, ?, ?, ?, ?)`)
  for (let i = 0; i < steps.length; i++) {
    stmt.run(jigId, entity, i + 1, steps[i].name, steps[i].description, steps[i].costHint)
  }
}

export function getJigSteps(jigId: string, entity: string | null): JigStepRow[] {
  const db = openDb()
  return db.prepare(`SELECT * FROM jig_steps WHERE jig_id = ? AND entity IS ? ORDER BY seq`).all(jigId, entity) as JigStepRow[]
}

export function upsertJigMeta(jigId: string, entity: string | null, codeHash: string): void {
  const db = openDb()
  db.prepare(`DELETE FROM jig_meta WHERE jig_id = ? AND entity IS ?`).run(jigId, entity)
  db.prepare(`INSERT INTO jig_meta (jig_id, entity, code_hash) VALUES (?, ?, ?)`).run(jigId, entity, codeHash)
}

export function getJigMeta(jigId: string, entity: string | null): JigMetaRow | null {
  const db = openDb()
  return db.prepare(`SELECT * FROM jig_meta WHERE jig_id = ? AND entity IS ?`).get(jigId, entity) as JigMetaRow | null
}

export function cleanupOrphanedMeta(activeJigIds: Set<string>): void {
  const db = openDb()
  const allMeta = db.prepare(`SELECT DISTINCT jig_id FROM jig_meta`).all() as { jig_id: string }[]
  for (const { jig_id } of allMeta) {
    if (!activeJigIds.has(jig_id)) {
      db.prepare(`DELETE FROM jig_meta WHERE jig_id = ?`).run(jig_id)
      db.prepare(`DELETE FROM jig_steps WHERE jig_id = ?`).run(jig_id)
    }
  }
}
```

- [ ] **Step 6: Run tests**

Run: `bun test test/db.test.ts`
Expected: all pass

- [ ] **Step 7: Commit**

```bash
git add src/db.ts test/db.test.ts
git commit -m "Add jig_steps and jig_meta tables with CRUD + cleanup"
```

---

### Task 3: Step Derivation in Creator Pipeline

**Files:**
- Modify: `src/creator.ts` (after line 124 in createJig, after line 199 in editJig)
- Modify: `src/db.ts` (import hash utility)

- [ ] **Step 1: Add deriveSteps function to creator.ts**

After the `extractImportedServers()` function (line 762), add:
```typescript
/** Derive human-readable steps from jig code via LLM. Non-blocking — skips on failure. */
export async function deriveSteps(code: string, jigId: string, entity?: string): Promise<void> {
  try {
    const { openDb, upsertJigSteps, upsertJigMeta } = await import("./db.js")
    openDb()

    const steps = await llm<{ name: string; description: string; costHint?: string }[]>(
      `Analyze this jig code and extract the sequential steps it performs.
Return a JSON array of steps, each with: name (short action title), description (tool call or brief explanation), costHint (e.g. "$0.003" for LLM calls, omit for tool calls).

Only include meaningful steps — skip imports, variable declarations, config. Focus on actions: tool calls, LLM calls, human approval, API calls.

Code:
${code}`,
      {},
      { schema: { steps: "[{ name: string, description: string, costHint?: string }]" } }
    )

    const stepArray = Array.isArray(steps) ? steps : (steps as any).steps ?? []
    upsertJigSteps(jigId, entity ?? null, stepArray.map(s => ({
      name: s.name,
      description: s.description,
      costHint: s.costHint ?? null,
    })))

    const hasher = new Bun.CryptoHasher("sha256")
    hasher.update(code)
    upsertJigMeta(jigId, entity ?? null, hasher.digest("hex"))
  } catch (e) {
    // Step derivation is enhancement, not blocking — log and continue
    console.error("Warning: Failed to derive steps:", (e as Error)?.message ?? e)
  }
}
```

- [ ] **Step 2: Call deriveSteps after createJig writes the file**

In `createJig()`, after the file is written (around line 124, after `await Bun.write(targetPath, code)`), add:
```typescript
await deriveSteps(code, plan.name, plan.entity)
```

- [ ] **Step 3: Call deriveSteps after editJig writes the file**

In `editJig()`, after the file is written (around line 199, after `await Bun.write(targetPath, code)`), add:
```typescript
await deriveSteps(code, name, entity)
```

- [ ] **Step 4: Inject default trigger when LLM omits it**

In `createJig()` and `editJig()`, after code generation and before the final `Bun.write`, add a check:
```typescript
// Ensure trigger is present (default to manual if LLM omitted it)
if (!/trigger\s*:/.test(code)) {
  code = code.replace(
    /jig\(\s*["'][^"']+["']\s*,\s*\{/,
    (match) => `${match}\n    trigger: { type: "manual" },`
  )
}
```

- [ ] **Step 5: Run tests to verify nothing broke**

Run: `bun test`
Expected: all pass (deriveSteps is only called during actual jig creation, not tests)

- [ ] **Step 5: Commit**

```bash
git add src/creator.ts
git commit -m "Add LLM step derivation to creator pipeline"
```

---

### Task 4: API — Serve Steps + Stale Detection

**Files:**
- Modify: `src/server.ts:136-170` (buildJigResponse)

- [ ] **Step 1: Import new db functions at top of server.ts**

Update the import line (line 9) to add:
```typescript
import { openDb, insertRun, completeRun, insertStep, completeStep, getJigRuns, getRun, getLastRun, getJigSteps, getJigMeta, cleanupOrphanedMeta } from "./db.js"
```

- [ ] **Step 2: Add hash computation helper**

After `cronToText()` (line 67), add:
```typescript
function fileHash(content: string): string {
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(content)
  return hasher.digest("hex")
}
```

- [ ] **Step 3: Update buildJigResponse to serve steps + detect staleness**

In `buildJigResponse()` (lines 136-170), replace the `steps: []` line and add stale detection. After `const code = ...` and before the return, add:
```typescript
// Steps from SQLite (derived by creator pipeline)
const entity = grouped ? entities[0] : null
const cachedSteps = getJigSteps(id, entity)
const steps = cachedSteps.map((s, i) => ({
  num: s.seq,
  name: s.name,
  desc: s.description,
  cost: s.cost_hint ?? undefined,
}))

// Stale detection: compare file hash against cached
const meta = getJigMeta(id, entity)
const currentHash = code ? fileHash(code) : null
const stale = !meta || (currentHash !== null && meta.code_hash !== currentHash)
```

Update the return object: replace `steps: [],` with `steps,` and add `stale,` after `status`.

- [ ] **Step 4: Add cleanup to handleGetJigs**

In `handleGetJigs()` (line 176), after `const discovered = discoverJigs(JIGS_DIR)`, add:
```typescript
cleanupOrphanedMeta(new Set(discovered.keys()))
```

- [ ] **Step 5: Test with curl**

Run: `bun run src/server.ts &` then:
```bash
curl -s http://localhost:3141/api/jigs | python3 -c "import sys,json; d=json.load(sys.stdin); j=d[0]; print(f'steps={len(j[\"steps\"])} stale={j.get(\"stale\")}')"
```
Expected: `steps=0 stale=True` (no steps cached yet, so stale)

- [ ] **Step 6: Commit**

```bash
git add src/server.ts
git commit -m "Serve cached steps from SQLite, add stale detection"
```

---

### Task 5: API — Recompile + Edit Endpoints

**Files:**
- Modify: `src/server.ts` (add handlers + routes)

- [ ] **Step 1: Add recompile handler**

After `handleGetConnections()`, add:
```typescript
async function handleRecompile(id: string, body: any): Promise<Response> {
  const discovered = discoverJigs(JIGS_DIR)
  if (!discovered.has(id)) return notFound(`Jig not found: ${id}`)

  const entity = body?.entity as string | undefined
  const filePath = getJigFilePath(id, entity)
  if (!filePath) return notFound(`Jig file not found`)

  const code = readFileSync(filePath, "utf-8")

  // TypeScript validation (per spec — recompile must validate)
  const { validate } = await import("./creator.js")
  const tsErrors = validate(filePath)
  if (tsErrors) return json({ ok: false, error: `TypeScript errors:\n${tsErrors}` }, 400)

  // Re-derive steps
  const { deriveSteps } = await import("./creator.js")
  await deriveSteps(code, id, entity)

  const steps = getJigSteps(id, entity ?? null)
  return json({
    ok: true,
    steps: steps.map(s => ({ num: s.seq, name: s.name, desc: s.description, cost: s.cost_hint })),
  })
}
```

- [ ] **Step 2: Add edit handler with concurrency guard**

Add at module level (before the handlers):
```typescript
const editLocks = new Map<string, { editId: string; status: string; message?: string }>()
```

Then add the handler:
```typescript
async function handleEditJig(id: string, body: any): Promise<Response> {
  const discovered = discoverJigs(JIGS_DIR)
  if (!discovered.has(id)) return notFound(`Jig not found: ${id}`)

  const instruction = body?.instruction as string
  if (!instruction) return json({ error: "instruction is required" }, 400)

  const entity = body?.entity as string | undefined
  const lockKey = entity ? `${id}/${entity}` : id

  if (editLocks.has(lockKey)) return json({ error: "Edit already in progress" }, 409)

  const editId = crypto.randomUUID()
  editLocks.set(lockKey, { editId, status: "planning" })

  ;(async () => {
    try {
      const { editJig } = await import("./creator.js")
      const io = {
        ask: async () => instruction,
        emit: (event: any) => {
          const lock = editLocks.get(lockKey)
          if (!lock) return
          if (event.type === "plan") lock.status = "selecting-tools"
          else if (event.type === "probe-start") lock.status = "probing"
          else if (event.type === "generate-start") lock.status = "generating"
          else if (event.type === "validate") lock.status = "validating"
          else if (event.type === "dry-run-start") lock.status = "dry-running"
          else if (event.type === "updated") lock.status = "done"
          else if (event.type === "error") { lock.status = "error"; lock.message = event.message }
        },
      }
      await editJig(id, entity, instruction, io)
      const lock = editLocks.get(lockKey)
      if (lock) lock.status = "done"
    } catch (e: any) {
      const lock = editLocks.get(lockKey)
      if (lock) { lock.status = "error"; lock.message = e?.message ?? String(e) }
    }
  })()

  return json({ editId })
}

async function handleEditStatus(id: string, editId: string): Promise<Response> {
  const discovered = discoverJigs(JIGS_DIR)
  if (!discovered.has(id)) return notFound(`Jig not found: ${id}`)

  // Find lock matching this jig
  for (const [key, lock] of editLocks) {
    if ((key === id || key.startsWith(id + "/")) && lock.editId === editId) {
      const result = { status: lock.status, message: lock.message }
      // Clean up completed locks
      if (lock.status === "done" || lock.status === "error") editLocks.delete(key)
      return json(result)
    }
  }
  return json({ status: "done" }) // Unknown editId = already completed
}
```

- [ ] **Step 3: Add routes**

In `matchRoute()`, add before the `return null`:
```typescript
// POST /api/jigs/:id/recompile
const recompileMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/recompile$/)
if (recompileMatch) return { handler: "recompile", params: { id: recompileMatch[1] } }

// POST /api/jigs/:id/edit
const editMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/edit$/)
if (editMatch) return { handler: "editJig", params: { id: editMatch[1] } }

// GET /api/jigs/:id/edit-status?editId=...
const editStatusMatch = pathname.match(/^\/api\/jigs\/([^/]+)\/edit-status$/)
if (editStatusMatch) return { handler: "editStatus", params: { id: editStatusMatch[1] } }
```

In the `switch` inside `createApiServer`, add cases:
```typescript
case "recompile": {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  const body = await req.json().catch(() => ({}))
  return handleRecompile(route.params.id, body)
}
case "editJig": {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405)
  const body = await req.json().catch(() => ({}))
  return handleEditJig(route.params.id, body)
}
case "editStatus": {
  const editId = url.searchParams.get("editId") ?? ""
  return handleEditStatus(route.params.id, editId)
}
```

- [ ] **Step 4: Run tests**

Run: `bun test`
Expected: all pass

- [ ] **Step 5: Commit**

```bash
git add src/server.ts
git commit -m "Add recompile and edit API endpoints with concurrency guard"
```

---

### Task 6: Dashboard — Stale Banner + Edit Button

**Files:**
- Modify: `dashboard/src/types/jig.ts:26-41`
- Modify: `dashboard/src/components/jig-detail-pane.tsx`
- Modify: `dashboard/src/components/dashboard-shell.tsx:29,73-78,146-148`

- [ ] **Step 1: Add stale to Jig type**

In `dashboard/src/types/jig.ts`, add after `status` (line 30):
```typescript
stale?: boolean;
```

- [ ] **Step 2: Add stale banner + recompile to JigDetailPane**

In `jig-detail-pane.tsx`, after the header `</div>` and before the Steps/Code toggle section, add:
```tsx
{/* Stale warning */}
{jig.stale && (
  <div className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-amber-500/20 bg-amber-500/5 px-3 py-2" style={{ animation: "fade-up 0.15s ease" }}>
    <span className="h-1.5 w-1.5 rounded-full bg-amber-400 shrink-0" />
    <span className="text-[11px] text-amber-300 flex-1">Code changed outside the dashboard. Steps may be outdated.</span>
    <button
      onClick={async () => {
        await fetch(`/api/jigs/${encodeURIComponent(jig.id)}/recompile`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entity: selectedEntity ?? undefined }),
        });
        window.location.reload();
      }}
      className="text-[10px] text-amber-400 hover:text-amber-300 transition-colors font-medium"
    >
      Re-compile
    </button>
  </div>
)}
```

- [ ] **Step 3: Wire Edit button to reviewMode in DashboardShell**

In `dashboard-shell.tsx`, the JigDetailPane already has an Edit button (pencil icon). Update the `onClose` prop passed to JigDetailPane to also include an `onEdit` callback. First, add an `onEdit` prop to `JigDetailPane`:

In `jig-detail-pane.tsx`, update the props type:
```typescript
export function JigDetailPane({ jig, selectedEntity, onClose, onEdit, expanded = false, onToggleExpand }: {
  jig: Jig;
  selectedEntity: string | null;
  onClose: () => void;
  onEdit?: () => void;
  expanded?: boolean;
  onToggleExpand?: () => void;
}) {
```

Wire the existing pencil edit button (line 39):
```tsx
<button onClick={onEdit} className="rounded-md border border-[#1f1f23] bg-[#111113] px-2.5 py-1 text-[11px] text-[#888] transition-colors duration-150 hover:bg-[#1a1a1d]" title="Edit">&#9998;</button>
```

In `dashboard-shell.tsx`, update the JigDetailPane render (line 146-148):
```tsx
<JigDetailPane
  jig={currentJig}
  selectedEntity={selectedEntity}
  onClose={() => { setDetailExpanded(false); closeDetail(); }}
  onEdit={() => { setReviewMode(true); }}
  expanded={detailExpanded}
  onToggleExpand={() => setDetailExpanded(!detailExpanded)}
/>
```

- [ ] **Step 4: Build dashboard**

Run: `cd dashboard && pnpm run build`
Expected: builds successfully

- [ ] **Step 5: Commit**

```bash
git add dashboard/src/types/jig.ts dashboard/src/components/jig-detail-pane.tsx dashboard/src/components/dashboard-shell.tsx
git commit -m "Add stale warning banner and wire Edit button to reviewMode"
```

---

### Task 7: Dashboard — Wire ReviewPane for Editing

**Files:**
- Modify: `dashboard/src/components/review-pane.tsx`
- Modify: `dashboard/src/components/dashboard-shell.tsx`

- [ ] **Step 1: Add isEditing props to ReviewPane**

Update ReviewPane props:
```typescript
export function ReviewPane({ jig, onClose, isEditing = false }: {
  jig: Jig;
  onClose: () => void;
  isEditing?: boolean;
}) {
```

- [ ] **Step 2: Update banner text + bottom buttons**

Change the construction banner (line 24-28) to be conditional:
```tsx
<div className="construction-stripe mx-4 mt-3 rounded-md px-3 py-1.5 text-[11px] font-medium text-amber-200">
  {isEditing ? `Editing — ${jig.name}` : "Draft — not compiled yet"}
</div>
```

Change the "Compile & Save" button (line 152-156):
- When `isEditing`: show "Done" (returns to detail pane) + "Discard" (reverts to original)
- Disable if trigger is empty with tooltip "Set a trigger first"
```tsx
{isEditing ? (
  <div className="flex gap-2 px-4 py-3">
    <button onClick={onClose} className="flex-1 rounded-md bg-emerald-600 py-2 text-[12px] font-medium text-white">Done</button>
    <button onClick={onDiscard} className="rounded-md border border-[#1f1f23] px-4 py-2 text-[12px] text-[#888]">Discard</button>
  </div>
) : (
  <button disabled={!triggerValue} title={!triggerValue ? "Set a trigger first" : ""} className="...">
    Compile &amp; Save
  </button>
)}
```

- [ ] **Step 3: Wire "Edit with AI" to the API**

Add state for the edit flow:
```typescript
const [editInput, setEditInput] = useState("");
const [editId, setEditId] = useState<string | null>(null);
const [editStatus, setEditStatus] = useState<string | null>(null);
const [editError, setEditError] = useState<string | null>(null);
```

Wire the existing input element (line 108-112) to state by adding `value={editInput} onChange={(e) => setEditInput(e.target.value)}` to the `<input>`.

Wire the Apply button (currently has no onClick) in the "Edit with AI" section:
```tsx
<button
  onClick={async () => {
    if (!editInput.trim()) return;
    setEditError(null);
    try {
      const res = await fetch(`/api/jigs/${encodeURIComponent(jig.id)}/edit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instruction: editInput }),
      });
      if (res.status === 409) { setEditError("Edit already in progress"); return; }
      if (!res.ok) { setEditError("Failed to start edit"); return; }
      const { editId: id } = await res.json();
      setEditId(id);
      setEditStatus("planning");

      // Poll for completion
      for (let i = 0; i < 120; i++) {
        await new Promise(r => setTimeout(r, 1000));
        const poll = await fetch(`/api/jigs/${encodeURIComponent(jig.id)}/edit-status?editId=${id}`);
        if (!poll.ok) continue;
        const data = await poll.json();
        setEditStatus(data.status);
        if (data.status === "done") { setEditId(null); window.location.reload(); return; }
        if (data.status === "error") { setEditError(data.message ?? "Edit failed"); setEditId(null); return; }
      }
      setEditError("Timed out");
      setEditId(null);
    } catch (e: any) {
      setEditError(e?.message ?? "Unknown error");
    }
  }}
  disabled={!!editId || !editInput.trim()}
  className="shrink-0 rounded-md bg-blue-600 px-3 py-1.5 text-[11px] font-medium text-white transition-all duration-150 hover:bg-blue-500 disabled:opacity-50"
>
  {editId ? "Applying…" : "Apply"}
</button>
```

- [ ] **Step 4: Update pipeline progress dots**

The ReviewPane already has progress dots (Plan → Select tools → Probe → Generate → Validate). Wire them to `editStatus`:
```tsx
{["planning", "selecting-tools", "probing", "generating", "validating", "dry-running"].map((stage, i) => {
  const active = editStatus === stage;
  const done = editStatus !== null && ["planning","selecting-tools","probing","generating","validating","dry-running","done"].indexOf(editStatus) > i;
  return (
    <span key={stage} className={`h-1.5 w-1.5 rounded-full transition-colors ${active ? "bg-blue-400 animate-pulse" : done ? "bg-emerald-400" : "bg-[#333]"}`} />
  );
})}
```

- [ ] **Step 5: Pass isEditing from DashboardShell**

In `dashboard-shell.tsx`, update the ReviewPane render (line 150-152):
```tsx
<ReviewPane jig={currentJig} onClose={closeDetail} isEditing={!!(selectedJig && jigs.find(j => j.id === selectedJig))} />
```

Pass `isEditing` based on whether the jig already exists in the list (editing vs creating new):
```tsx
<ReviewPane jig={currentJig} onClose={closeDetail} isEditing={jigs.some(j => j.id === selectedJig)} />
```

Also add `onDiscard` prop — in DashboardShell, store original code before entering edit mode and pass a discard handler:
```typescript
const [originalCode, setOriginalCode] = useState<string | null>(null);

// In the onEdit handler:
setOriginalCode(currentJig?.code ?? null);
setReviewMode(true);

// onDiscard: restore original via recompile endpoint, then exit reviewMode
```

- [ ] **Step 6: Build dashboard**

Run: `cd dashboard && pnpm run build`
Expected: builds successfully

- [ ] **Step 7: Commit**

```bash
git add dashboard/src/components/review-pane.tsx dashboard/src/components/dashboard-shell.tsx
git commit -m "Wire ReviewPane for editing with AI via API + pipeline progress"
```

---

### Task 8: End-to-End Verification

- [ ] **Step 1: Run all tests**

Run: `bun test`
Expected: all pass

- [ ] **Step 2: Build dashboard**

Run: `cd dashboard && JIG_API_PORT=4173 pnpm run build`
Expected: builds with `/`, `/mock` routes

- [ ] **Step 3: Test jig start end-to-end**

Run: `jig start`, open browser, verify:
- Weekly Update shows "Mon 8:00" trigger
- Steps show (if previously derived — empty on first load, stale=true)
- Click "Re-compile" → steps get derived and appear
- Click "Edit" → ReviewPane opens with "Editing — Weekly Update"
- Mock route at `/mock` still works with phase toggle

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "Fix: end-to-end verification fixes"
```

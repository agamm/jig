# Session Summary — Dashboard Integration & Runtime

## What Was Built

### Core Infrastructure
- **SQLite database** (`src/db.ts`) — runs, run_steps, jig_steps, jig_meta tables
- **Bun API server** (`src/server.ts`) — 10+ endpoints for jigs, runs, connections, editing
- **`jig start` command** (`src/start.ts`) — launches API + Next.js on single port via rewrites
- **Run worker** (`src/run-worker.ts`) — executes jigs in isolated subprocess
- **Step derivation** (`src/creator.ts:deriveSteps`) — LLM analyzes code into steps
- **Jig validator** (`src/validate.ts`) — validates jig structure, trigger, handler

### Dashboard (Next.js)
- **Live page** (`/`) — fetches from API, shows real jig data
- **Mock page** (`/mock`) — preserves design mockups with mock data
- **DashboardShell** — shared layout component
- **RunSteps** — unified step list (idle/running/done), agent grouping, tool badges
- **useJigRun hook** — run lifecycle, polling, cancel, AbortController cleanup
- **Highlighted code** — multi-line template literal aware tokenizer

### Features
- **Run/Dry Run** from dashboard with real-time progress
- **Cancel** — kills subprocess with SIGKILL
- **Step derivation** — LLM extracts steps with tool names, connections, agent groups
- **Active tool tracking** — spinner callback → runProgress → poll → UI badges
- **Auto-derive** — steps derived automatically on first jig view
- **Past runs** — readable dates, output preview, expandable
- **Trigger editing** — inline edit with suggestions
- **Edit with AI** — ReviewPane wired to editJig API
- **Stale detection** — file hash comparison, auto-re-derive
- **Running indicator** — pulsing blue dot in jig list for active runs

## Bugs Fixed

### Critical
1. **Dry-run flag never reset** — `setDryRun(false)` missing from finally block
2. **Spinner ReferenceError** — dynamic import inside try, unavailable in finally
3. **validate not exported** — recompile endpoint imported non-exported function
4. **Module cache** — jig imports cached, edits not picked up (added `?t=` cache buster)
5. **Concurrent run corruption** — global spinner/dryRun shared across runs (added activeRunId guard)
6. **Poll 404 for dry runs** — `/api/runs/-1` route regex `\d+` doesn't match negative numbers
7. **ctx.log stdout corruption** — worker's jig output mixed with JSON protocol (fixed with `silent: true`)
8. **Empty runProgress** — not initialized before worker starts, errors lost
9. **Stale connection files** — `.jig/connections/` referencing removed modules (auto-regenerate on start)

### Important
- **isEditing always true** — `jigs.some()` always matched, replaced with explicit state
- **Empty steps** — `steps: []` because derivation only ran during create/edit
- **Running runs in history** — filtered out (shown in live panel only)
- **Duplicate React keys** — connection names and tool names can repeat
- **Date parsing** — hardcoded "Mar " replacement, replaced with proper Date parsing
- **Infinite derive loop** — auto-derive on empty steps → reload → still empty → loop (guarded)

### UX
- **Global cursor:pointer** on all buttons via CSS
- **Blank right pane** — main area shrank when selectedJig referenced nonexistent jig
- **Fan-out animation** — connection icons too fast (200ms → 500ms ease-out)
- **Agent group collapse** — removed (always expanded, simpler)
- **Format duration** — `116.4s` → `1m 56s` everywhere

## Architecture Decisions

### Subprocess Execution
Jigs run in isolated `Bun.spawn` subprocess (`src/run-worker.ts`).
- **Why:** Cancel = `proc.kill(9)`. No global state corruption. Server stays alive.
- **Trade-off:** Can't share in-process state. Tool progress via stdout JSON protocol.

### Polling vs SSE
Dashboard polls `/api/runs/active` every 1s.
- **Why:** Simple, works with Next.js rewrites, no WebSocket setup needed.
- **Trade-off:** 1s latency on tool progress updates. Acceptable for now.

### Count-based step matching (abandoned)
Tried matching completedTools count to derived step boundaries. Failed because agent calls tools nondeterministically.
- **Final approach:** Show active tools on the agent group header, not per-step.

### No page reload for step derivation
Steps update in-place via `localSteps` state. No `window.location.reload()`.

## Pre-flight Checks (jig start)
1. Auto-install dashboard deps if `node_modules` missing
2. Auto-regenerate stale connection files (detect `sdk/connections` imports)
3. Check pnpm install exit code
4. Check connections exist before running
5. Worker validates default export, params JSON, module imports

## Known Limitations
- **Global spinner singleton** — only one run at a time (guarded with activeRunId)
- **Global dryRun flag** — same limitation (guarded)
- **Trigger editing** — Save button not wired to API
- **Chat** — still mock data
- **Approval pane** — still mock data
- **LLM step derivation** — can fail silently, falls back to "Derive steps" button
- **Lockfile warning** — two lockfiles (bun.lock + pnpm-lock.yaml), harmless

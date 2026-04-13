# Jig Dashboard — Design & Integration Guide

## Overview

Static design mockup for the Jig dashboard. Built with Next.js 16 + Tailwind CSS v4. Currently uses mock data — designed to be swapped for real API calls when integrating with the Jig runtime.

**Branch:** `design-r8`
**Design philosophy:** Vercel-inspired dark UI. Warm grays (#0a0a0b base), subtle borders (#1f1f23), 150ms transitions. Every element earns its place.

---

## Architecture

```
src/
├── app/page.tsx              # Orchestrator (144 lines) — global state + layout
├── types/jig.ts              # All shared interfaces
├── lib/mock-data.ts          # Mock data — replace with API layer
├── components/
│   ├── service-icon.tsx      # Icon registry with SVG brand logos (server)
│   ├── connection-tag.tsx    # [icon Name] pill badge (server)
│   ├── sparkline.tsx         # Mini bar chart SVG (server)
│   ├── step-list.tsx         # Shared numbered step list with tool badges (server)
│   ├── step-io.tsx           # Tabbed Input/Output viewer (client)
│   ├── highlighted-code.tsx  # Syntax highlighting with inline service badges (server)
│   ├── chat-panel.tsx        # Left sidebar — chat with assistant (client)
│   ├── jig-list.tsx          # Center — filterable, DnD-reorderable jig list (client)
│   ├── jig-detail-pane.tsx   # Right pane — compiled jig detail (client)
│   ├── review-pane.tsx       # Right pane — draft jig with construction stripes (client)
│   ├── approval-pane.tsx     # Right pane — pending approval detail (client)
│   └── onboarding-view.tsx   # Day 1 welcome + service connection cards (server)
├── hooks/
│   ├── use-resizable-pane.ts # Drag-to-resize panel width
│   └── use-drag-reorder.ts   # HTML5 DnD list reordering
└── app/
    ├── globals.css            # Dark theme, animations (shimmer, flip, fade-up, etc.)
    └── layout.tsx             # Root layout with Geist fonts
```

### State Ownership

| State | Owner | Consumers |
|-------|-------|-----------|
| `phase` | page.tsx | Controls which view renders (day1/week2/month3) |
| `selectedJig` | page.tsx | JigList (highlight), JigDetailPane/ReviewPane (content) |
| `activeApproval` | page.tsx | ApprovalPane (content) |
| `reviewMode` | page.tsx | Decides ReviewPane vs JigDetailPane |
| `expandedGroup` | page.tsx | JigList (which group is expanded) |
| `jigOrder*` | page.tsx | JigList (DnD reorder mutates this) |
| `chatWidth` | useResizablePane | ChatPanel (width prop) |
| `detailTab`, `editingTrigger`, `expandedRun`, `selectedDay` | JigDetailPane/ReviewPane | Internal to each pane |
| `draggingIdx`, `dropTargetIdx`, `dropSide` | useDragReorder in JigList | Internal to JigList |
| `jigSearch` | JigList | Internal filter state |

---

## Three Right-Panel Components

The right side of the screen shows one of three mutually exclusive panes:

### 1. `JigDetailPane` — Compiled jig
**When:** `selectedJig && !reviewMode && !activeApproval`
**Shows:** Steps/Code toggle, trigger (editable) + Run/Dry Run, run history with expandable step outputs, costs & usage (month/lifetime/avg), connections.

### 2. `ReviewPane` — Draft/uncompiled jig
**When:** `selectedJig && reviewMode`
**Shows:** Construction stripe banner ("Draft — not compiled yet"), editable steps, trigger (editable, no Run buttons), "Edit with AI" input with suggestion pills, pipeline progress indicator (Plan → Select tools → Probe → Generate → Validate), connections with "+ Add" button, "Compile & Save" button.

### 3. `ApprovalPane` — Pending approval
**When:** `activeApproval && !selectedJig`
**Shows:** Jig name + connections, run progress (completed steps + stuck step with amber highlight), expandable step I/O (tabbed Input/Output), artifacts (PDF, MD, JSON with preview links), Approve & Continue / Reject buttons.

---

## Integration Caveats

### Mock Data → Real API

`lib/mock-data.ts` contains all mock data. When integrating:

1. **Replace imports** in page.tsx:
   - `JIGS_WEEK2` / `JIGS_MONTH3` → fetch from Jig runtime API (`/api/jigs`)
   - `CHAT_MESSAGES` → agent session events from the backend agent API (`/api/agent`)
   - `APPROVAL_DATA` → future approval backend; no approval API is wired yet

2. **The `Jig` interface** (`types/jig.ts`) maps to the runtime's jig discovery + run history. Key mappings:
   - `jig.steps` → derived from AST parsing (the "natural language view" from plan.md)
   - `jig.code` → raw file content from `jigs/*.ts`
   - `jig.runs` → from SQLite run history
   - `jig.settings.trigger` → from the jig's `trigger` field
   - `jig.settings.connections` → from the jig's `tools` array (map tool to server name)
   - `jig.costMonth` / `costLifetime` → aggregated from `llm()` call cost tracking

3. **Phase toggle** (`day1`/`week2`/`month3`) is for design demo only. Remove when integrating — the real state is derived from actual data (0 jigs = onboarding, otherwise show the list).

### Components That Need Real Data Hooks

| Component | Currently | Needs |
|-----------|-----------|-------|
| `ChatPanel` | Static messages array | Hook into the agent API (`/api/agent`) via the shared polling flow |
| `JigList` | In-memory array with DnD | API fetch + optimistic reorder |
| `JigDetailPane` | Mock runs/costs | Fetch run history, aggregate costs |
| `ApprovalPane` | Hardcoded single approval | Future approval backend; do not assume a `ctx.human()` queue exists |
| `ReviewPane` | Static steps | Connect to the shared backend authoring flow through `/api/agent` |
| `OnboardingView` | Static cards | Real `/api/connections` + `/api/connections/:name/connect` flow |

### Scalability Notes

- **Jig list:** No virtualization. Fine for <50 jigs. For 100+, add `react-window` or pagination.
- **Run history:** Capped at 5 visible + day filter. Real implementation should paginate from SQLite.
- **Artifacts:** Wrapped in `max-h-[300px] overflow-y-auto`. Works for dozens. For 100+, paginate.
- **Chat:** Scrollable container. For long conversations, implement "load more" at scroll top.
- **Code view:** Renders all lines. For large jig files (500+ lines), consider lazy rendering.

### Icon System

`ServiceIcon` uses a static `ICON_REGISTRY` with inline SVG paths. Currently supports: Gmail, Google Calendar, Google Drive, GitHub, Slack, AI/LLM. Unknown services get a colored first-letter circle fallback.

**To add a new service icon:**
1. Find SVG on [simple-icons](https://github.com/simple-icons/simple-icons) (CC0 license) or similar
2. Add entry to `ICON_REGISTRY` in `service-icon.tsx` with `viewBox` and `paths`
3. Add aliases to `ICON_ALIASES` if needed (e.g., `"google drive": "drive"`)

**Security:** `dangerouslySetInnerHTML` is used for SVG rendering. Safe because paths come from the static registry, never user input. Do not connect to dynamic/API data without sanitization.

### CSS Animations

Defined in `globals.css`:
- `fade-up` — element entrance (opacity + translateY)
- `fade-in` — opacity only
- `slide-in-right` — right pane entrance
- `flip-in` — Steps/Code tab switch
- `shimmer` — "Save as Jig" button gradient
- `pulse-amber` — pending approval glow
- `.construction-stripe` — diagonal orange stripes for draft jigs
- `.flip-enter` — class to trigger flip animation

### DnD Reordering

`useDragReorder` implements HTML5 drag & drop for jig list reordering. Currently persists in React state only — order is lost on refresh. When integrating:
- Save order to user preferences (localStorage or API)
- Consider `@dnd-kit` for accessibility (keyboard reorder, screen readers)

### Resizable Chat Pane

`useResizablePane` handles mouse-based resize (200px–600px range). Caveats:
- No touch support (mobile)
- No keyboard resize
- Width not persisted across sessions — save to localStorage when integrating

---

## Design Decisions & Rationale

### Why left chat + right detail (not full-screen chat)?
User feedback across 36+ design iterations: "Most options need a conversational first approach either to interact with UI or to create it" BUT "conversational only isn't good, doesn't show info that might be relevant." The split layout gives chat as the entry point while keeping structured data always visible.

### Why 3 separate right panes (not one with modes)?
Tried a single `JigDetailPane` with `reviewMode` prop — resulted in 50%+ of content being conditionally hidden/shown, messy code. Three components are cleaner, each with clear purpose and no wasted renders.

### Why status dots instead of left borders?
Earlier iterations used thick colored left borders on jig rows. User feedback: "the left side of jigs looks awful." Status dots (6px circles) are subtler and don't dominate the visual hierarchy.

### Why no marketplace?
Removed per user direction — "too soon." Tracked in `status.md` roadmap for future. The component structure supports adding a marketplace tab/section when ready.

### Why no standing permissions UI?
Standing permissions (always/ask/never per action) are v0.2 on the roadmap. The approval pane currently shows approve/reject only. When permissions land, add the "Always allow X for this jig" checkbox back.

---

## Key Files for Integration

| Integration Point | File | What to Change |
|-------------------|------|---------------|
| Jig data source | `lib/mock-data.ts` → `lib/api.ts` | Replace static arrays with fetch calls |
| Type definitions | `types/jig.ts` | Align with runtime types from `src/sdk/jig.ts` |
| Chat backend | `components/chat-panel.tsx` | Connect to the shared agent backend via `/api/agent` |
| Run execution | `components/jig-detail-pane.tsx` | Wire Run/Dry Run buttons to `jig run` API |
| Jig creation | `components/review-pane.tsx` | Start a backend authoring session through `/api/agent` |
| AI editing | `components/review-pane.tsx` | Reuse the same backend authoring session flow through `/api/agent` |
| Approval flow | `components/approval-pane.tsx` | Keep as future work; no approval backend is wired today |
| OAuth connect | `components/onboarding-view.tsx` | Wire to `/api/connections` and `/api/connections/:name/connect` |
| Service discovery | `components/service-icon.tsx` | Load icons dynamically from connected servers |

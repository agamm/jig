# Jig Dashboard

Next.js 16 + Tailwind CSS v4, served next to the Bun API. The dashboard is for looking and for
quick actions: run a jig by hand, inspect runs, approve or discard a pending change, connect
services, pair the CLI, read logs. Jigs are written and changed by a coding agent (Claude Code,
Codex) in a checkout paired to the instance; every place that used to ask an in-server agent now
offers a copy-ready prompt for that coding agent. Without a coding agent, replying to the
failure email edits the jig.

## How it talks to the server

`src/proxy.ts` forwards `/api/*` to the Bun API on loopback (`JIG_API_PORT`). All backend logic
lives in `src/server.ts` of the repo root; nothing here calls a model or touches the database.
Every API call goes through a typed helper in `src/lib/api.ts` against the contracts in
`shared/api.ts`; SWR hooks in `src/lib/swr.ts` own polling and revalidation.

## Layout

`components/dashboard-page.tsx` loads data; `components/dashboard-shell.tsx` owns the view
routing (query state via nuqs), the sidebar and the resizable split panes (`resizable.tsx`).

| View | Components | What it does |
|---|---|---|
| Jigs | `jig-list.tsx`, `jig-detail-pane.tsx`, `run-steps.tsx`, `jig-versions.tsx`, `pending-changes-banner.tsx` | Run and dry-run, run history with step output, versions, approve or discard pending, copy a change or fix prompt |
| Setup | `setup-view.tsx` | Runs the shared `shared/setup-flow.ts` wizard, model probe with fix links, CLI pairing (auto-copies the command), first-jig prompt |
| Connections | `connection-pane.tsx`, `onboarding-view.tsx` | Connect and verify services, custom MCP servers, starter prompts |
| Settings | `models-settings.tsx`, `agentmail-settings.tsx`, `backup-settings.tsx`, `system-settings.tsx`, `danger-settings.tsx` | Model slots (main, fast), alert email, backup, reset |
| Logs | `logs-settings.tsx` | Live operational log from the API server |

Shared pieces: `button.tsx`, `copy-button.tsx` (copy + toast, used for every prompt), `toast.tsx`,
`state-panel.tsx` (empty, loading, notice), `spinner.tsx` + `shimmer-text.tsx` (the loading
language: spinner plus shimmering text, never plain "Loading"), `service-icon.tsx`.

`src/lib/agent-prompts.ts` builds the prompts handed to the coding agent (change, fix a failed
step, new jig). They are plain text and name the instance by origin.

## Design language

Dark, warm grays (`--background #0a0a0b`, borders `#1f1f23`), 150ms transitions, a soft radial
glow at the top of every pane (`.pane-glow`). Animations in `app/globals.css`: `fade-up`,
`fade-in`, `slide-in-right`, `flip-in`, `shimmer`, `text-shimmer`, `setup-step-approved`.
Loading states use `Spinner` + `ShimmerText`. Icons come from svgrepo-style inline SVGs in
`service-icon.tsx`; unknown services fall back to a lettered circle.

## Working on it

`pnpm install` and `pnpm run dev` in this directory (not bun). `jig start` from the repo root
starts both servers. Typecheck with `./node_modules/.bin/tsc --noEmit`. Do not run `shadcn init`
here; it overwrites the theme.

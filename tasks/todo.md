# Agent-first Jig: remove in-server authoring, examples as prompts, settings in SDK, audit log (2026-09-04)

Plan: ~/.claude/plans/wondrous-humming-donut.md. Archive branch: archive/in-server-authoring (pushed).

## Step 1: Part B (remove interactive authoring) + Part G (copy prompts)
- [x] Server: agent-service trims, /api/agent* routes, contracts, dead code (buildCreatorJigPrompt, jig-gen ask thread), tests
- [x] Dashboard: delete create pane / agent panel / input / activity / draft banner / busy frame / review pane / use-agent / use-input-history; trim shell, detail pane, jig list, onboarding, pending banner, run-steps, lib
- [x] Dashboard: copy-button.tsx, agent-prompts.ts, copy buttons (change, fix, new jig), setup READY card reworded
- [x] CLI: no `new`, flagless `edit` is usage, session.ts gone, help text
- [x] Docs touched by step 1
- [x] Green: bun test, root tsc, dashboard tsc; commit

## Step 2: Part D (editor role)
- [x] Merged as d043a37 (740 pass)
## Step 3: Part C (examples as prompts)
- [x] Merged (739 pass)
- [x] Step 6: deleted the unused refreshJigs helper in dashboard-shell.tsx
## Step 4: Part E (settings in the SDK + migration + SKILL.md)
- [x] Merged as 0babffc (754 pass)
## Step 5: Part F (audit log + jig debug audit)
- [x] Merged (all green)
## Step 6: version bump, Part H doc sweep, push main
- [x] Audit every remaining "authoring agent" mention (validate.ts messages, SKILL.md, agentmail-settings.tsx, notify.ts, classify-reply.ts, docs/jig-architecture.svg): keep only where it means the headless email/repair loop
- [x] FirstJig card uses newJigPrompt wording (self-contained for a checkout); dead .construction-stripe CSS dropped (Part C)

## Review

- Five commits on main after the archive branch: authoring removal (42 files, -3150), editor role, examples as prompts, SDK settings (+ migration v24), audit log. Version 0.1.131.
- Verified: 772 tests, root and dashboard typechecks, whitespace; end to end against a scratch instance over HTTP as a paired clone: `jig edit --file --approve` with model/runTimeoutMs/toolTimeoutMs in source (modelInCode reported, override fields gone), a failing run, `jig debug ls`, `jig debug audit` text and --json naming the step, error and next command; `/api/agent` 404; `/api/models` main+fast; `/api/examples` prompts; dashboard pages 200 with a clean dev log.
- Not verified: the dashboard visually (Chrome extension disconnected during the smoke); the email question round-trip and auto-repair against live AgentMail (unit tests only).
- Left for later, deliberately: the "failed again" and 24h summary email bodies do not yet name the failing step (only the first failure email does); the natural-language trigger editor stays.

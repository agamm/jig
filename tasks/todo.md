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
## Step 3: Part C (examples as prompts)
## Step 4: Part E (settings in the SDK + migration + SKILL.md)
## Step 5: Part F (audit log + jig debug audit)
## Step 6: version bump, Part H doc sweep, push main
- [ ] Audit every remaining "authoring agent" mention (validate.ts messages, SKILL.md, agentmail-settings.tsx, notify.ts, classify-reply.ts, docs/jig-architecture.svg): keep only where it means the headless email/repair loop
- [ ] FirstJig card uses newJigPrompt wording (self-contained for a checkout); drop dead .construction-stripe CSS

## Review
(pending)

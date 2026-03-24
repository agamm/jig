# Jig — Status

## v0 (current) — Prove the model

- [x] Project scaffolding (Bun, TypeScript, package.json)
- [x] Default MCP server configs (Workspace, Granola, GitHub)
- [x] MCP client library (connect, discover, call tools)
- [x] OAuth provider (file-based token persistence, browser auth flow)
- [x] `auth` config for servers without dynamic registration (e.g. `"auth": "gh auth token"`)
- [x] Type generator (schemas → .d.ts + runtime connection modules)
- [x] SDK: `jig()`, `run()`, `llm()`, `agent()`, `ctx.parallel()`, `ctx.params`
- [x] `agent()` — LLM with bounded tool calling (the "bigger hatch")
- [x] LLM via OpenRouter (plain text + structured output)
- [x] CLI: `jig connect`, `jig run` with interactive param prompts
- [x] Connect Google Workspace (56 tools), Granola (4 tools), GitHub (44 tools)
- [x] Test jig: weekly-update with agent() gathering from all 3 sources
- [x] Grouped jig discovery (folder = jig ID, files = entity variants, `_` prefix = skip)
- [x] `jig run <name> <entity>` / `jig run <name> all`
- [x] `--dry-run` flag (read tools execute, mutations print + stub)
- [x] Read/write tool detection via MCP verb heuristic (tokenizer, mutation-safe default)
- [x] Upstream/clone distribution model
- [x] Better error messages (missing connections, missing API key)
- [x] Phase B: create Gmail draft from generated email

## Roadmap

### v0.1 — `jig new` / `jig edit` (AI jig authoring)
- [ ] `jig new` — describe what you want, AI generates a jig file using SKILL.md + available tools
- [ ] `jig edit <name>` — AI modifies an existing jig based on natural language instruction
- [ ] `jig edit <name> <entity>` — edit a specific grouped jig variant
- [ ] Feed SKILL.md, available connection types, and existing jig (for edit) as context
- [ ] Write output directly to `jigs/` (or `jigs/<name>/` for grouped)

### v0.2 — Dashboard + CLI
- [ ] Dashboard (web UI): jig list, run detail, connections
- [ ] `jig connections` CLI command
- [ ] Run telemetry: model used, token count / estimated cost, wall-clock time per run

### v0.3 — Permissions + Approval
- [ ] Standing permissions (always / ask / never) per action
- [ ] `ctx.human()` approval flow
- [ ] Approval queue in dashboard

### v0.4 — Storage + Durability
- [ ] SQLite via `bun:sqlite` (jig.db)
- [ ] Run history with step results (append-only)
- [ ] Durable step memoization (resume on crash)
- [ ] `ctx.state` persistent key-value store
- [ ] Dashboard: grouped jig view (entity list with per-entity run status)

### v0.5 — Auto-Update
- [ ] On `jig start`, if `upstream` remote exists, `git pull upstream main` in background
- [ ] Skip if no `upstream` remote (this IS the upstream)
- [ ] Dashboard: show update indicator

### v0.6 — Scheduling + Triggers
- [ ] Cron scheduler (persistent, survives restarts)
- [ ] Event triggers (MCP webhooks)
- [ ] Webhook server (trigger URLs per jig)
- [ ] File watcher (hot reload jigs)

### v0.7 — Compilation + Self-Healing
- [ ] **Agent compilation**: observe `agent()` tool call order across runs, compile to static `llm()` + explicit tool calls when pattern stabilizes. Saves tokens, runs faster, fully deterministic.
- [ ] **Agent fallback**: when a compiled jig step fails, fall back to `agent()` mode to self-heal. If it heals repeatedly, suggest recompiling with the new pattern.
- [ ] Cost tracking per `llm()` and `agent()` call
- [ ] Per-jig budget limits

### v1.0 — Dashboard v2
- [ ] Jig params + presets (saved by dashboard, not jig code)
- [ ] AST-derived step visualization
- [ ] GenUI exploration (Tambo, Vercel AI SDK, etc.)
- [ ] PWA with push notifications

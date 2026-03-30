# Jig

## 1. Plan Mode Default
- Enter plan mode for ANY non-trivial task (3+ steps or architectural decisions)
- If something goes sideways, STOP and re-plan immediately - don't keep pushing
- Use plan mode for verification steps, not just building
- Write detailed specs upfront to reduce ambiguity

## 2. Subagent Strategy
- Use subagents liberally to keep main context window clean
- Offload research, exploration, and parallel analysis to subagents
- For complex problems, throw more compute at it via subagents
- One task per subagent for focused execution

## 3. Self-Improvement Loop
- After ANY correction from the user: update `tasks/lessons.md` with the pattern
- Write rules for yourself that prevent the same mistake
- Ruthlessly iterate on these lessons until mistake rate drops
- Review lessons at session start for relevant project

## 4. Verification Before Done
- Never mark a task complete without proving it works
- Diff behavior between main and your changes when relevant
- Ask yourself: "Would a staff engineer approve this?"
- Run tests, check logs, demonstrate correctness

## 5. Demand Elegance (Balanced)
- For non-trivial changes: pause and ask "is there a more elegant way?"
- If a fix feels hacky: "Knowing everything I know now, implement the elegant solution"
- Skip this for simple, obvious fixes - don't over-engineer
- Challenge your own work before presenting it

## 6. Autonomous Bug Fixing
- When given a bug report: just fix it. Don't ask for hand-holding
- Point at logs, errors, failing tests - then resolve them
- Zero context switching required from the user
- Go fix failing CI tests without being told how

## Task Management
1. **Plan First**: Write plan to `tasks/todo.md` with checkable items
2. **Verify Plan**: Check in before starting implementation
3. **Track Progress**: Mark items complete as you go
4. **Explain Changes**: High-level summary at each step
5. **Document Results**: Add review section to `tasks/todo.md`
6. **Capture Lessons**: Update `tasks/lessons.md` after corrections

## Integration Principles
- **Browser OAuth only** — users never register OAuth apps, create API tokens, or manage credentials manually
- For servers that don't support dynamic registration, use `auth` in config (a shell command that returns a bearer token from an existing tool, e.g. `"auth": "gh auth token"`)
- No `client_id`, `client_secret`, or PAT fields in configs — ever
- MCP for everything — consistency and low maintenance over custom HTTP integrations

## Privacy
- **No personal or client info in code** — never commit real company names, contact details, repo names, or email addresses. Use generic placeholders ("CompanyName", "repo-name", "Your Name").
- Examples in comments/docs should use fictional names only.

## Architecture
- **Next.js is a thin proxy** — the dashboard (`dashboard/`) is a Next.js frontend that rewrites `/api/*` to the Bun API server (`src/server.ts`) via `next.config.ts`. All backend logic (LLM calls, file I/O, DB) goes in `src/server.ts`, never in Next.js API routes or middleware. The Bun server auto-loads `.env`; Next.js does not.
- **Dashboard uses pnpm, not bun** — Next.js doesn't work well with bun for package management. The dashboard has its own `pnpm-lock.yaml`. Use `pnpm install` and `pnpm run dev` in `dashboard/`. `jig start` auto-installs dashboard deps via pnpm if `node_modules` is missing.
- **Don't import SDK modules into server.ts** — `src/sdk/` (llm.ts, context.ts, etc.) is designed for jig runtime, not the API server. For server-side LLM calls, use direct `fetch` to OpenRouter instead of `getClient()`.

## Code Style
- **Programmatic over subprocess** — use library APIs (e.g. TypeScript compiler API, Bun APIs) instead of spawning CLI tools. Keeps things faster, more portable, and dashboard-ready.
- **Abstract all I/O** — business logic must never call `console.log`, `process.exit`, or read `process.stdin` directly. Pass I/O through callback interfaces (like `JigIO`) so the same logic works from CLI and dashboard. The CLI file is thin glue that wires IO; the modules are reusable.

## Core Principles
- **Simplicity First**: Make every change as simple as possible. Impact minimal code.
- **No Laziness**: Find root causes. No temporary fixes. Senior developer standards.

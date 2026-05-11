<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Jig-Specific Guidance

For any work that changes how jigs are authored, run, reviewed, or displayed in the dashboard, also follow the root [`../SKILL.md`](../SKILL.md). That file is the source of truth for Jig workflow structure, `jig()` usage, `ctx.step()` rules, tool declarations, and runtime expectations.

Dashboard/server API rule: define every fixed internal API contract in [`../shared/api.ts`](../shared/api.ts). Dashboard callers should go through typed helpers in [`src/lib/api.ts`](src/lib/api.ts), not ad hoc `fetch("/api/...")` calls. Server success responses should use `apiJson()` or `apiJsonWithHeaders()` with the matching contract key so response shapes are checked against `ApiContracts`. Do not duplicate request/response interfaces in component files when a shared contract type already exists.

Authoring backend rule: the dashboard and CLI must share the same backend authoring path and server-strategy logic.
Default servers expose the connected/generated `.d.ts` and schema tool surface directly.
`apify` is special: authoring may use its meta-tools at build time to resolve the best Actor, then runtime code should target the resolved Actor path instead of emitting `search_actors` discovery code.
`composio` is also special via config-driven proxy/discovery hooks: authoring should use the discovered connected-tool surface, not raw meta-tools.
If a server needs special authoring behavior, it should come from config such as `.authoringDiscovery` or `.proxy.connectDiscovery`, not from a separate frontend-only path.

When inspecting or transforming jig code, avoid brittle regex parsing when a syntax-aware or runtime-aware option exists. Prefer TypeScript/AST analysis, language tooling, or actual runtime properties first; use an LLM only when the structure is too fuzzy for a simple robust parser.

For larger bug fixes or feature changes, do an explicit review pass before calling the work done. That review should look for correctness issues, edge cases, dead code, and unnecessary compatibility layers, not just typecheck/test success.

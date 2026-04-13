<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# Jig-Specific Guidance

For any work that changes how jigs are authored, run, reviewed, or displayed in the dashboard, also follow the root [`../SKILL.md`](../SKILL.md). That file is the source of truth for Jig workflow structure, `jig()` usage, `ctx.step()` rules, tool declarations, and runtime expectations.

When inspecting or transforming jig code, avoid brittle regex parsing when a syntax-aware or runtime-aware option exists. Prefer TypeScript/AST analysis, language tooling, or actual runtime properties first; use an LLM only when the structure is too fuzzy for a simple robust parser.

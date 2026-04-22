# Contributing

Thanks for your interest in Jig! A few ground rules before you open an issue or a PR.

## Supported setup

Jig is built and tested against a specific stack. Issues on setups outside it will be **automatically deprioritized** (not ignored — just moved behind issues that affect the default path).

**Supported:**
- **Runtime:** Bun (not Node, not Deno)
- **Deploy target:** Railway (for `jig deploy`)
- **Package manager:** Bun for the root project, pnpm for `dashboard/`
- **MCP servers:** the defaults shipped in `servers/` (Composio, Workspace, Granola, GitHub, Apify). Custom MCPs are fine to use, but bugs specific to them live at the bottom of the queue.
- **Model router:** OpenRouter (free tier works for most flows)

If you're running on a different stack (npm + Node, Vercel/Fly/self-hosted, custom MCP servers, direct Anthropic/OpenAI instead of OpenRouter, etc.), please say so up front in the issue. We may still look at it, but "it works on the supported stack" will close it without a fix.

## Filing issues

Use the templates:
- **Bug** — something that works on the supported stack is broken
- **Feature** — something the supported stack can't do yet

Include: your OS, Bun version, the jig file (or a minimal repro), and the exact command you ran.

## PRs

- Keep the diff small and focused on one change.
- Run `bun test` before pushing.
- Match the style of surrounding code — no drive-by reformatting.
- If your change touches the agent, the runtime, or the DB schema, add a test.

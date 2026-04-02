# Declarative Steps + Tool Enforcement

## Problem

Step derivation runs the jig handler with stub values (`scanStub`) to discover what tools are called. This is fundamentally fragile — every new code pattern (filters, method chains, conditionals) breaks the proxies. 50+ lines of proxy complexity that still fails on common patterns.

Additionally, tools are loosely tracked — jigs can call any tool from any imported connection, making it impossible to know at a glance what a jig does or to enforce permissions per step.

## Solution

Three changes:

1. **Declarative steps** — jig authors declare steps with human-readable names and allowed tools using `ctx.step("Name", [tools], handler)`. Steps are known from source without execution.
2. **Per-step tool enforcement** — only tools listed in the current step's array can be called. Enforced at runtime by the generated tool wrapper.
3. **No more scan/stubs** — steps and tools are read directly from source code. LLM only needed to derive steps from legacy jigs that don't use the new syntax.

## New `ctx.step()` API

### Block-scoped with callback

```typescript
async (ctx) => {
  const emails = await ctx.step("Fetch recent emails", [
    workspace.gmail_search,
    workspace.gmail_get,
  ], async () => {
    const results = await workspace.gmail_search({ q: "is:inbox newer_than:7d" })
    // workspace.gmail_send would throw here — not in this step's tools
    return results
  })
  // No tools allowed between steps — any tool call here throws

  await ctx.step("Send summary", [
    workspace.gmail_send,
  ], async () => {
    await workspace.gmail_send({ to: "me@example.com", body: "..." })
    // workspace.gmail_search would throw here
  })
}
```

### Behavior

- `ctx.step(label, tools, fn)` — sets `ctx._currentStepTools` to the tool names, runs `fn`, then clears the allowed tools on exit
- Between steps (before first step, between step calls): no tools are allowed. Any tool call throws.
- `agent()` and `llm()` calls are always allowed (they're SDK functions, not connection tools)
- The step callback can return a value (like `const emails = await ctx.step(...)`)
- Steps must be sequential — no nesting

### Runtime enforcement

In the generated connection module (`typegen.ts`), the tool wrapper checks before executing:

```typescript
const ctx = runContext.getStore()
if (ctx && !ctx.isToolAllowedInCurrentStep(name)) {
  throw new Error(
    `Tool "${serverName}.${name}" is not allowed in step "${ctx.currentStepLabel}".`
    + ` Allowed tools: ${ctx.currentStepToolNames.join(', ')}`
  )
}
```

### Static validation (check_jig)

The jig checker validates:
1. Every tool in `jig({ tools: [...] })` is used in at least one step
2. Every tool referenced in a `ctx.step()` call is in the jig-level `tools` array
3. No tool calls appear outside `ctx.step()` blocks (warn, not error — for migration)

## Step Derivation (No Execution)

### For new jigs (declarative steps)

Steps are fully declared in source. To extract them:
1. Read jig source as string
2. Parse `ctx.step("label", [tool1, tool2], ...)` calls — regex or simple AST
3. Map tool variable names to their connection/tool via the imports at top of file
4. Return `CachedStep[]` — same format as today

No LLM needed. No handler execution. Deterministic.

### For legacy jigs (no declarative steps)

Jigs that use auto-stepping (direct tool calls without `ctx.step()`) still work at runtime — auto-stepping is preserved. For the dashboard step preview, fall back to:
1. LLM reads source code, extracts likely steps + tools
2. Or: show flat tool list from `jig({ tools })` without step grouping

### Cache

Same `step_cache` table keyed by `(jig_id, code_hash)`. Re-derives when code changes.

## What a Jig Looks Like Now

```typescript
import { jig, agent } from "jig"
import { workspace } from "jig/connections/workspace.js"

export default jig("meeting-brief", {
  trigger: { type: "cron", cron: "0 * * * *" },
  tools: [
    workspace.calendar_listEvents,
    workspace.gmail_search,
    workspace.gmail_get,
    workspace.gmail_send,
  ],
}, async (ctx) => {

  const events = await ctx.step("Get upcoming meetings", [
    workspace.calendar_listEvents,
  ], async () => {
    return workspace.calendar_listEvents({
      calendarId: "primary",
      timeMin: new Date().toISOString(),
      timeMax: new Date(Date.now() + 3600_000).toISOString(),
    })
  })

  if (!events?.length) {
    ctx.output("No upcoming meetings")
    return
  }

  const briefing = await ctx.step("Research meeting context", [
    workspace.gmail_search,
    workspace.gmail_get,
  ], async () => {
    return agent(
      `Research context for meeting: ${events[0].summary}`,
      [workspace.gmail_search, workspace.gmail_get]
    )
  })

  await ctx.step("Send briefing email", [
    workspace.gmail_send,
  ], async () => {
    await workspace.gmail_send({
      to: "user@example.com",
      subject: `Brief: ${events[0].summary}`,
      body: briefing,
    })
  })
})
```

## What Gets Removed

| File | Remove |
|------|--------|
| `src/sdk/context.ts` | `scanStub()`, `stubElement()`, `MAX_STUB_DEPTH`, `stepScanContext`, `isStepScan()` |
| `src/sdk/jig.ts` | `scanSteps()`, `ScannedStep*` types |
| `src/sdk/llm.ts` | `scanStub` import, `isStepScan()` checks |
| `src/mcp/typegen.ts` | `scanStub` import, `isStepScan()` return |
| `.jig/connections/*.ts` | `scanStub` import, `isStepScan()` return (regenerated) |
| `src/server.ts` (`handleGetSteps`) | Remove subprocess — just read source file |

## What Changes

| File | Change |
|------|--------|
| `src/sdk/context.ts` | New `ctx.step(label, tools, fn)` signature, `_currentStepTools`, `isToolAllowedInCurrentStep()` |
| `src/mcp/typegen.ts` | Add per-step tool enforcement check in tool wrapper |
| `src/derive-steps.ts` | Parse source for `ctx.step()` declarations instead of scanning |
| `src/services/jig-checker.ts` | Validate tool usage matches declarations |
| `src/services/jig-writing-prompt.ts` | Update jig writing instructions to use new `ctx.step()` syntax |

## Migration

Existing jigs without `ctx.step()` blocks continue to work — auto-stepping from direct tool calls is preserved. The jig-level `tools` array enforcement is the only breaking change (tools must be declared). The agent can migrate jigs to the new syntax when editing them.

## Not Changing

- `agent()` / `llm()` SDK functions — always allowed, not gated by step tools
- Step cache table schema — same `CachedStep` format
- Dashboard step/tool display components — same data shape
- `RunEvent` stream — unchanged
- Tool review flow — unchanged

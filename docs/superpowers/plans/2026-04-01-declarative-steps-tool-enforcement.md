# Declarative Steps + Tool Enforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace fragile scanStub proxy with declarative `ctx.step(label, tools, fn)` and per-step tool enforcement. Legacy jigs get an "Upgrade" button in the dashboard.

**Architecture:** `ctx.step()` gains a new 3-arg overload that sets allowed tools for the duration of the callback. Generated tool wrappers check `ctx.isToolAllowedInCurrentStep()` before executing. Step derivation reads `ctx.step()` calls from source code instead of executing the handler. Legacy jigs (no block-scoped steps) show an upgrade prompt in the dashboard.

**Tech Stack:** TypeScript, Bun, SQLite (existing), Next.js dashboard (existing)

---

### Task 1: New `ctx.step()` overload with per-step tool enforcement

**Files:**
- Modify: `src/sdk/context.ts`
- Test: `test/context.test.ts`

The new overload: `ctx.step(label, tools, fn)` — sets allowed tools, runs fn, clears tools. The old `ctx.step(label)` overload still works (for auto-stepping in legacy jigs — no enforcement).

- [ ] **Step 1: Write failing test for block-scoped step**

```typescript
// test/context.test.ts
import { describe, it, expect } from "bun:test"
import { Context, runContext } from "../src/sdk/context"

describe("ctx.step block-scoped", () => {
  it("runs callback and returns its value", async () => {
    const ctx = new Context({}, [])
    const result = await ctx.step("Test step", [], async () => {
      return 42
    })
    expect(result).toBe(42)
  })

  it("sets and clears currentStepLabel", async () => {
    const ctx = new Context({}, [])
    let insideLabel: string | null = null
    await ctx.step("My Step", [], async () => {
      insideLabel = ctx.currentStepLabel
    })
    expect(insideLabel).toBe("My Step")
    expect(ctx.currentStepLabel).toBeNull()
  })

  it("sets and clears currentStepToolNames", async () => {
    const mockTool = { _serverName: "workspace", _toolName: "gmail_send", _readOnly: false } as any
    const ctx = new Context({}, ["gmail_send"])
    let insideTools: string[] = []
    await ctx.step("Send", [mockTool], async () => {
      insideTools = ctx.currentStepToolNames
    })
    expect(insideTools).toEqual(["gmail_send"])
    expect(ctx.currentStepToolNames).toEqual([])
  })

  it("isToolAllowedInCurrentStep returns true for listed tool", async () => {
    const mockTool = { _serverName: "workspace", _toolName: "gmail_send", _readOnly: false } as any
    const ctx = new Context({}, ["gmail_send"])
    let allowed = false
    await ctx.step("Send", [mockTool], async () => {
      allowed = ctx.isToolAllowedInCurrentStep("gmail_send")
    })
    expect(allowed).toBe(true)
  })

  it("isToolAllowedInCurrentStep returns false for unlisted tool", async () => {
    const mockTool = { _serverName: "workspace", _toolName: "gmail_send", _readOnly: false } as any
    const ctx = new Context({}, ["gmail_send"])
    let allowed = true
    await ctx.step("Send", [mockTool], async () => {
      allowed = ctx.isToolAllowedInCurrentStep("gmail_search")
    })
    expect(allowed).toBe(false)
  })

  it("isToolAllowedInCurrentStep returns false between steps", () => {
    const ctx = new Context({}, ["gmail_send"])
    expect(ctx.isToolAllowedInCurrentStep("gmail_send")).toBe(false)
  })

  it("clears tools even if callback throws", async () => {
    const mockTool = { _serverName: "workspace", _toolName: "gmail_send", _readOnly: false } as any
    const ctx = new Context({}, ["gmail_send"])
    try {
      await ctx.step("Fail", [mockTool], async () => { throw new Error("boom") })
    } catch {}
    expect(ctx.currentStepToolNames).toEqual([])
    expect(ctx.currentStepLabel).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/context.test.ts`
Expected: FAIL — `ctx.step` doesn't accept 3 args yet

- [ ] **Step 3: Implement block-scoped ctx.step**

In `src/sdk/context.ts`, add the new overload and per-step tool tracking to the `Context` class:

```typescript
// New private fields (add after _stepFinalized):
private _currentStepToolNames: string[] = []
private _currentStepLabel: string | null = null

// Public getters:
get currentStepLabel(): string | null { return this._currentStepLabel }
get currentStepToolNames(): string[] { return this._currentStepToolNames }

isToolAllowedInCurrentStep(toolName: string): boolean {
  if (this._currentStepLabel === null) return false // no active step
  if (this._currentStepToolNames.length === 0) return true // legacy step (no enforcement)
  return this._currentStepToolNames.includes(toolName)
}

// Replace existing step() method with overloaded version:
step(label: string): void
step<T>(label: string, tools: JigTool[], fn: () => Promise<T>): Promise<T>
step<T>(label: string, tools?: JigTool[], fn?: () => Promise<T>): void | Promise<T> {
  // Finish previous step if one was active
  if (this._stepSeq > 0 && !this._stepFinalized) {
    this.finalize()
  }
  this._stepSeq++
  this._stepFinalized = false
  this._stepStart = Date.now()
  this._stepOutput = []
  this._stepConnections = new Set()
  this._stepTools = new Map()
  this._currentStepLabel = label
  this._recorder?.onStepStart(this._stepSeq, label)

  // Block-scoped: set allowed tools, run fn, clear on exit
  if (fn && tools) {
    this._currentStepToolNames = tools.map(t => t._toolName)
    for (const tool of tools) {
      this.addTool(tool._serverName, tool._toolName, tool._readOnly ?? true)
    }
    return (async () => {
      try {
        const result = await fn()
        this.finalize()
        return result
      } catch (e) {
        this.finalize(e)
        throw e
      } finally {
        this._currentStepToolNames = []
        this._currentStepLabel = null
      }
    })()
  }

  // Legacy: no enforcement, tools cleared by next step() call
  this._currentStepToolNames = []
}
```

Note: the `JigTool` type import is needed — add `import type { JigTool } from "./jig.js"` at the top of context.ts. This is not a circular import — it's a type-only import.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test test/context.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/sdk/context.ts test/context.test.ts
git commit -m "feat: add block-scoped ctx.step(label, tools, fn) with per-step tool tracking"
```

---

### Task 2: Runtime tool enforcement in generated connection modules

**Files:**
- Modify: `src/mcp/typegen.ts` (the template)
- Regenerate: `.jig/connections/*.ts`

The generated tool wrapper checks `ctx.isToolAllowedInCurrentStep(name)` before executing. If the tool isn't allowed, throw with a clear message.

- [ ] **Step 1: Update typegen template**

In `src/mcp/typegen.ts`, replace the `tool()` function template. Remove `isStepScan`/`scanStub` imports and the scan stub return. Add enforcement check:

```typescript
// Change the import line in the template (line ~91):
import { runContext } from "../../src/sdk/context"

// Replace the tool() function template (line ~118):
function tool(name: string, readOnly: boolean) {
  const fn = async (params: any) => {
    const ctx = runContext.getStore()
    // Per-step tool enforcement
    if (ctx && !ctx.isToolAllowedInCurrentStep(name)) {
      throw new Error(
        \`Tool "${serverName}.\${name}" is not allowed in step "\${ctx.currentStepLabel ?? "(no active step)"}". \`
        + \`Declare it in the tools array of your ctx.step() call.\`
      )
    }
    if (ctx && !ctx.inAgent) ctx.step("${serverName}." + name)
    ctx?.addTool("${serverName}", name, readOnly)
    if (isDryRun() && !readOnly) {
      console.log(\`\\n[dry-run] ${serverName}.\${name}\`)
      return { _dryRun: true, tool: name, params }
    }
    return callTool(await conn(), name, params ?? {})
  }
  fn._serverName = "${serverName}"
  fn._toolName = name
  fn._readOnly = readOnly
  return fn as JigTool<any, any>
}
```

**Important:** When `ctx.currentStepLabel` is null AND `ctx._currentStepToolNames` is empty (no active block-scoped step), `isToolAllowedInCurrentStep` returns false. But for legacy jigs that use `ctx.step(label)` (1-arg), the label IS set but tools array is empty — `isToolAllowedInCurrentStep` returns true (no enforcement). This means legacy jigs continue to work — enforcement only kicks in for block-scoped steps.

- [ ] **Step 2: Regenerate connection files**

Run: `bun run src/mcp/typegen.ts` (or whatever the regeneration command is — check `jig connect` flow)

Alternatively, manually update the 3 existing connection files to match the new template:
- `.jig/connections/workspace.ts`
- `.jig/connections/granola.ts`
- `.jig/connections/github.ts`

Remove `isStepScan, scanStub` import, remove `if (isStepScan()) return scanStub()`, add the enforcement check.

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit 2>&1 | grep -v jig-gen.ts`
Expected: Clean (no errors)

- [ ] **Step 4: Commit**

```bash
git add src/mcp/typegen.ts .jig/connections/
git commit -m "feat: add per-step tool enforcement in generated connection modules"
```

---

### Task 3: Remove scanStub, stepScanContext, scanSteps

**Files:**
- Modify: `src/sdk/context.ts` — remove `scanStub`, `stubElement`, `MAX_STUB_DEPTH`, `stepScanContext`, `isStepScan`
- Modify: `src/sdk/jig.ts` — remove `scanSteps`, `ScannedStep*` types
- Modify: `src/sdk/llm.ts` — remove `isStepScan`/`scanStub` imports and early returns
- Modify: `src/derive-steps.ts` — remove `scanSteps` import (will be replaced in Task 4)

- [ ] **Step 1: Remove from context.ts**

Delete `stepScanContext`, `isStepScan()`, `MAX_STUB_DEPTH`, `stubElement()`, `scanStub()` (lines 14-73 approximately). Keep `SkipError`, `runContext`, `truncLabel`, `RunRecorder`, `Context`.

- [ ] **Step 2: Remove from jig.ts**

Delete `scanSteps()` function and `ScannedStep`, `ScannedStepTool`, `ScannedStepWithTools` types (lines 70-114). Remove `stepScanContext` from the import.

- [ ] **Step 3: Remove from llm.ts**

Remove `isStepScan, scanStub` from the import line. Remove the two `if (isStepScan())` early returns in `llm()` (line ~37) and `agent()` (line ~110). The functions should now always execute or be gated by `isDryRun` only.

- [ ] **Step 4: Type check**

Run: `bunx tsc --noEmit 2>&1 | grep -v jig-gen.ts`
Expected: Errors in `derive-steps.ts` (it still imports `scanSteps`) — that's expected, fixed in Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/sdk/context.ts src/sdk/jig.ts src/sdk/llm.ts
git commit -m "refactor: remove scanStub, stepScanContext, and scanSteps"
```

---

### Task 4: Rewrite derive-steps.ts — parse source code for ctx.step() calls

**Files:**
- Rewrite: `src/derive-steps.ts`
- Test: `test/derive-steps.test.ts`

Replace the scan+humanize flow with source code parsing. For new-style jigs (block-scoped `ctx.step`), extract step names and tools directly from source — no LLM needed. For legacy jigs, return empty (dashboard shows upgrade prompt).

- [ ] **Step 1: Write failing test**

```typescript
// test/derive-steps.test.ts
import { describe, it, expect } from "bun:test"
import { parseStepsFromSource } from "../src/derive-steps"

describe("parseStepsFromSource", () => {
  it("extracts block-scoped steps with tools", () => {
    const code = `
import { jig } from "jig"
import { workspace } from "jig/connections/workspace.js"

export default jig("test", {
  trigger: { type: "manual" },
  tools: [workspace.gmail_search, workspace.gmail_send],
}, async (ctx) => {
  const emails = await ctx.step("Find emails", [
    workspace.gmail_search,
  ], async () => {
    return workspace.gmail_search({ q: "test" })
  })

  await ctx.step("Send reply", [
    workspace.gmail_send,
  ], async () => {
    await workspace.gmail_send({ to: "a@b.com", body: "hi" })
  })
})`
    const steps = parseStepsFromSource(code)
    expect(steps).toHaveLength(2)
    expect(steps[0].num).toBe(1)
    expect(steps[0].name).toBe("Find emails")
    expect(steps[0].tools).toEqual([
      { connection: "workspace", name: "gmail_search", readOnly: true },
    ])
    expect(steps[1].num).toBe(2)
    expect(steps[1].name).toBe("Send reply")
    expect(steps[1].tools).toEqual([
      { connection: "workspace", name: "gmail_send", readOnly: false },
    ])
  })

  it("returns empty for legacy jigs without block-scoped steps", () => {
    const code = `
import { jig } from "jig"
import { workspace } from "jig/connections/workspace.js"

export default jig("test", {
  trigger: { type: "manual" },
  tools: [workspace.gmail_search],
}, async (ctx) => {
  const result = await workspace.gmail_search({ q: "test" })
  ctx.output(result)
})`
    const steps = parseStepsFromSource(code)
    expect(steps).toHaveLength(0)
  })

  it("extracts connections from import statements", () => {
    const code = `
import { workspace } from "jig/connections/workspace.js"
import { granola } from "jig/connections/granola.js"

export default jig("test", {
  trigger: { type: "manual" },
  tools: [workspace.gmail_search, granola.get_meetings],
}, async (ctx) => {
  await ctx.step("Gather data", [
    workspace.gmail_search,
    granola.get_meetings,
  ], async () => {})
})`
    const steps = parseStepsFromSource(code)
    expect(steps[0].connections).toEqual(["workspace", "granola"])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/derive-steps.test.ts`
Expected: FAIL — `parseStepsFromSource` doesn't exist

- [ ] **Step 3: Implement parseStepsFromSource**

Rewrite `src/derive-steps.ts`:

```typescript
/**
 * Derive steps from jig source code.
 *
 * New jigs: parse ctx.step("label", [tools], fn) calls from source.
 * Legacy jigs: return empty — dashboard shows upgrade prompt.
 */
import type { CachedStep, CachedStepTool } from "./db.js"

/** Parse connection imports: import { workspace } from "jig/connections/workspace.js" */
function parseConnectionImports(code: string): Map<string, string> {
  const imports = new Map<string, string>() // varName -> serverName
  const re = /import\s*\{[^}]*\b(\w+)\b[^}]*\}\s*from\s*["']jig\/connections\/(\w+)\.(?:js|ts)["']/g
  for (const m of code.matchAll(re)) {
    imports.set(m[1], m[2])
  }
  return imports
}

/** Parse tool readOnly from schema files or default to true */
function inferReadOnly(toolName: string): boolean {
  const writeVerbs = ["send", "create", "update", "delete", "draft", "write", "remove", "post"]
  const lower = toolName.toLowerCase()
  return !writeVerbs.some(v => lower.includes(v))
}

/**
 * Extract steps from ctx.step("label", [tools], fn) calls in source code.
 * Returns empty array for legacy jigs that don't use block-scoped steps.
 */
export function parseStepsFromSource(code: string): CachedStep[] {
  const connections = parseConnectionImports(code)

  // Match ctx.step("label", [tool1, tool2, ...], async () => {
  const stepRegex = /ctx\.step\(\s*["'`]([^"'`]+)["'`]\s*,\s*\[([\s\S]*?)\]\s*,\s*async/g
  const steps: CachedStep[] = []
  let num = 0

  for (const match of code.matchAll(stepRegex)) {
    num++
    const name = match[1]
    const toolsBlock = match[2]

    // Parse tool references like workspace.gmail_search, granola.get_meetings
    const toolRefs = [...toolsBlock.matchAll(/(\w+)\.(\w+)/g)]
    const tools: CachedStepTool[] = []
    const stepConnections = new Set<string>()

    for (const ref of toolRefs) {
      const varName = ref[1]
      const toolName = ref[2]
      const serverName = connections.get(varName) ?? varName
      stepConnections.add(serverName)
      tools.push({
        connection: serverName,
        name: toolName,
        readOnly: inferReadOnly(toolName),
      })
    }

    steps.push({
      num,
      name,
      connections: [...stepConnections],
      tools,
    })
  }

  return steps
}

/**
 * Derive steps for a jig. Checks cache first, then parses source.
 */
export async function deriveSteps(
  jigId: string,
  code: string,
): Promise<CachedStep[]> {
  const { getStepCache, setStepCache } = await import("./db.js")

  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(code)
  const codeHash = hasher.digest("hex")

  const cached = getStepCache(jigId, codeHash)
  if (cached && cached.length > 0) return cached

  const steps = parseStepsFromSource(code)
  if (steps.length > 0) {
    try { setStepCache(jigId, codeHash, steps) } catch {}
  }

  return steps
}

/** Check if a jig uses legacy-style steps (no block-scoped ctx.step calls) */
export function isLegacyJig(code: string): boolean {
  return parseStepsFromSource(code).length === 0
}
```

Note: `deriveSteps` no longer takes a `JigDefinition` — just `jigId` and `code` string. Callers will need updating.

- [ ] **Step 4: Run tests**

Run: `bun test test/derive-steps.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/derive-steps.ts test/derive-steps.test.ts
git commit -m "feat: rewrite derive-steps to parse source code instead of scanning"
```

---

### Task 5: Update handleGetSteps and buildJigResponse callers

**Files:**
- Modify: `src/server.ts` — simplify `handleGetSteps` (no subprocess needed)
- Modify: `src/services/jig-api.ts` — update `buildJigResponse` to use new `deriveSteps` signature
- Modify: `shared/api.ts` — add `legacy?: boolean` to `JigData`

- [ ] **Step 1: Simplify handleGetSteps in server.ts**

Replace the subprocess that imports+scans with a simple source file read:

```typescript
async function handleGetSteps(id: string): Promise<Response> {
  ensureJigExists(id)
  const filePath = getJigFilePath(id)
  if (!filePath) throw new ApiError(404, "Jig file not found")

  const code = readFileSync(filePath, "utf-8")
  const { deriveSteps } = await import("./derive-steps.js")
  const steps = await deriveSteps(id, code)
  return json({ steps })
}
```

- [ ] **Step 2: Update buildJigResponse in jig-api.ts**

Change the step derivation to use the new `deriveSteps(id, code)` signature (no module import needed for steps):

```typescript
// Replace the step cache check block with:
if (includeSteps && code) {
  const { deriveSteps, isLegacyJig } = await import("../derive-steps.js")
  steps = await deriveSteps(id, code)
  legacy = isLegacyJig(code)
}
```

Add `legacy` to the returned `JigData`.

- [ ] **Step 3: Add `legacy` field to shared/api.ts JigData**

```typescript
export interface JigData {
  // ... existing fields ...
  legacy?: boolean  // true if jig doesn't use block-scoped ctx.step()
}
```

- [ ] **Step 4: Type check**

Run: `bunx tsc --noEmit 2>&1 | grep -v jig-gen.ts`
Expected: Clean

- [ ] **Step 5: Commit**

```bash
git add src/server.ts src/services/jig-api.ts shared/api.ts
git commit -m "feat: simplify step derivation — read source code, no subprocess"
```

---

### Task 6: Static validation — check undeclared tool usage

**Files:**
- Modify: `src/validate.ts`
- Test: `test/validate.test.ts`

Add validation that tool calls in the source match the declared tools array.

- [ ] **Step 1: Write failing test**

```typescript
// Add to test/validate.test.ts
import { describe, it, expect } from "bun:test"
import { checkToolDeclarations } from "../src/validate"

describe("checkToolDeclarations", () => {
  it("returns no errors when all tools are declared", () => {
    const code = `
import { workspace } from "jig/connections/workspace.js"
const x = jig("test", {
  tools: [workspace.gmail_search],
}, async (ctx) => {
  await ctx.step("Search", [workspace.gmail_search], async () => {
    await workspace.gmail_search({})
  })
})`
    const declaredTools = ["gmail_search"]
    expect(checkToolDeclarations(code, declaredTools)).toEqual([])
  })

  it("flags tool calls not in declared tools", () => {
    const code = `
import { workspace } from "jig/connections/workspace.js"
await workspace.gmail_send({ to: "x" })
`
    const declaredTools = ["gmail_search"]
    const errors = checkToolDeclarations(code, declaredTools)
    expect(errors.length).toBe(1)
    expect(errors[0].message).toContain("gmail_send")
    expect(errors[0].message).toContain("not declared")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/validate.test.ts`

- [ ] **Step 3: Implement checkToolDeclarations**

In `src/validate.ts`, add:

```typescript
/**
 * Check that all tool calls in source are declared in the tools array.
 * Returns validation errors for undeclared tools.
 */
export function checkToolDeclarations(code: string, declaredToolNames: string[]): ValidationError[] {
  const errors: ValidationError[] = []
  const declared = new Set(declaredToolNames)

  // Find connection imports
  const importRe = /import\s*\{[^}]*\b(\w+)\b[^}]*\}\s*from\s*["']jig\/connections\/(\w+)\.(?:js|ts)["']/g
  const connectionVars = new Map<string, string>()
  for (const m of code.matchAll(importRe)) {
    connectionVars.set(m[1], m[2])
  }

  // Find tool calls: connectionVar.toolName(
  for (const [varName, serverName] of connectionVars) {
    const callRe = new RegExp(`\\b${varName}\\.(\\w+)\\s*\\(`, "g")
    for (const m of code.matchAll(callRe)) {
      const toolName = m[1]
      if (!declared.has(toolName)) {
        errors.push({
          field: `tools.${serverName}.${toolName}`,
          message: `Tool "${serverName}.${toolName}" is used but not declared in the jig's tools array. Add it to tools: [...] in your jig() definition.`,
        })
      }
    }
  }

  return errors
}
```

Then wire it into `validateDefinition` in the same file — after the tools array check, call `checkToolDeclarations(code, declaredToolNames)` if source code is available. Update `validateJigFile` to read the source and pass it through.

- [ ] **Step 4: Run tests**

Run: `bun test test/validate.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/validate.ts test/validate.test.ts
git commit -m "feat: static validation of tool declarations vs usage"
```

---

### Task 7: Dashboard — "Upgrade Jig" button for legacy jigs

**Files:**
- Modify: `dashboard/src/components/jig-detail-pane.tsx`
- Modify: `dashboard/src/types/jig.ts` (if needed for the `legacy` field)

When `jig.legacy` is true, show a banner with an "Upgrade" button instead of the derivation-failed fallback. Clicking it sends a message to the agent to rewrite the jig using the new `ctx.step()` syntax.

- [ ] **Step 1: Add upgrade banner to jig-detail-pane.tsx**

Replace the `showDeriveFallback` section (around lines 361-370) with a legacy-aware version:

```tsx
{/* Legacy jig upgrade prompt */}
{jig.legacy && mode.type === "idle" && (
  <div className="mt-3 rounded-lg border border-blue-500/20 bg-blue-500/[0.04] p-3 text-left" style={{ animation: "fade-up 0.15s ease" }}>
    <p className="text-[10px] font-medium uppercase tracking-wider text-blue-400">Upgrade Available</p>
    <p className="mt-1 text-[11px] leading-relaxed text-blue-100/70">
      This jig uses the legacy format. Upgrade to declarative steps for better tool enforcement and step visibility.
    </p>
    <div className="mt-2">
      <Button
        onClick={() => {
          // Pre-fill the agent input with upgrade instruction
          const agentEl = document.querySelector<HTMLInputElement>('[placeholder*="Describe"]')
          if (agentEl) {
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set
            nativeInputValueSetter?.call(agentEl, 'Upgrade this jig to use declarative ctx.step("label", [tools], fn) syntax for each step.')
            agentEl.dispatchEvent(new Event('input', { bubbles: true }))
            agentEl.focus()
          }
        }}
        variant="accent"
        size="xs"
      >
        Upgrade Jig
      </Button>
    </div>
  </div>
)}
```

Note: A cleaner approach would be to expose a `setAgentInput` callback or ref from `AgentInput`. But the DOM approach works as a first pass. If the team prefers, refactor `AgentInput` to accept an `imperativeRef` with a `setValue` method.

- [ ] **Step 2: Type check dashboard**

Run: `cd dashboard && bunx tsc --noEmit`
Expected: Clean

- [ ] **Step 3: Commit**

```bash
git add dashboard/src/components/jig-detail-pane.tsx
git commit -m "feat: add 'Upgrade Jig' banner for legacy jigs in dashboard"
```

---

### Task 8: Update jig-writing-prompt to use new ctx.step() syntax

**Files:**
- Modify: `src/services/jig-writing-prompt.ts`

Update the agent's system prompt so it writes jigs with the new `ctx.step("label", [tools], fn)` syntax.

- [ ] **Step 1: Update the code format rules and example**

In `sharedJigWritingPolicy()` and `codeFormatRules()`, replace references to auto-stepping with the block-scoped step syntax:

```
### Structure every jig with ctx.step() blocks
- Wrap every logical step in ctx.step("Human-readable label", [tools], async () => { ... })
- Each step declares exactly which tools it uses — only those tools are allowed inside the block
- Steps must be sequential (no nesting)
- agent() and llm() calls don't need to be in the tools array — they're always allowed
- The step label should be human-readable (2-5 words): "Fetch calendar events", "Send briefing email"
```

Update the example jig in `agentExecutionRules()` to show the new syntax.

- [ ] **Step 2: Commit**

```bash
git add src/services/jig-writing-prompt.ts
git commit -m "feat: update jig writing prompt to use declarative ctx.step() syntax"
```

---

### Task 9: Migrate existing jigs to new format

**Files:**
- Modify: `jigs/weekly-update.ts` (if it exists and uses legacy format)
- Modify: `jigs/forgotten-emails.ts`
- Modify: `jigs/pre-meeting-briefing.ts`
- Modify: `jigs/meeting-prep.ts` (if it exists)

Convert each jig to use `ctx.step("label", [tools], async () => {...})` syntax. This is a manual migration — each jig's handler gets wrapped in step blocks.

- [ ] **Step 1: Migrate each jig**

For each jig, wrap tool calls in `ctx.step()` blocks with appropriate labels. Move `ctx.output()` calls inside the relevant step blocks.

- [ ] **Step 2: Run check_jig on each**

Run: `bun run src/validate.ts jigs/<name>.ts` for each migrated jig
Expected: All pass

- [ ] **Step 3: Type check**

Run: `bunx tsc --noEmit 2>&1 | grep -v jig-gen.ts`
Expected: Clean

- [ ] **Step 4: Commit**

```bash
git add jigs/
git commit -m "refactor: migrate existing jigs to declarative ctx.step() syntax"
```

---

### Task 10: Clean up and verify end-to-end

**Files:**
- Modify: `src/derive-steps.ts` — remove any leftover references
- Verify: `dashboard/src/lib/tool-review.ts` — ensure `getReviewableToolKeys` still works

- [ ] **Step 1: Full type check**

Run: `bunx tsc --noEmit 2>&1 | grep -v jig-gen.ts`
Run: `cd dashboard && bunx tsc --noEmit`
Expected: Both clean

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: All pass

- [ ] **Step 3: Manual verification**

1. Start the dashboard: `bun run src/server.ts` and `cd dashboard && pnpm dev`
2. Open a jig with block-scoped steps → verify steps show correctly with tools
3. Run a jig → verify tool enforcement (tool outside its step throws)
4. Open a legacy jig → verify "Upgrade" banner appears
5. Verify scheduler still works (schedules page, next run time)

- [ ] **Step 4: Commit any final fixes**

```bash
git add -A
git commit -m "chore: clean up and verify declarative steps + tool enforcement"
```

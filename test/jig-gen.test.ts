import { describe, it, expect } from "vitest"
import {
  stripCodeFences,
  extractImportedServers,
  hasExplicitEmptyToolsArray,
  collectBuildTimeToolPolicyIssues,
  deriveAuthoringServerScope,
} from "../src/jig-gen.js"
import { Context } from "../src/sdk/context.js"
import { jig, run } from "../src/sdk/jig.js"

describe("stripCodeFences", () => {
  it("strips typescript fences", () => {
    expect(stripCodeFences("```typescript\nconst x = 1\n```")).toBe("const x = 1")
  })

  it("strips ts fences", () => {
    expect(stripCodeFences("```ts\nconst x = 1\n```")).toBe("const x = 1")
  })

  it("strips bare fences", () => {
    expect(stripCodeFences("```\nconst x = 1\n```")).toBe("const x = 1")
  })

  it("returns code as-is when no fences", () => {
    expect(stripCodeFences("const x = 1")).toBe("const x = 1")
  })

  it("preserves multiline code", () => {
    const code = "```typescript\nconst x = 1\nconst y = 2\nconsole.log(x + y)\n```"
    expect(stripCodeFences(code)).toBe("const x = 1\nconst y = 2\nconsole.log(x + y)")
  })
})

describe("extractImportedServers", () => {
  it("extracts single server", () => {
    expect(extractImportedServers(
      `import { workspace } from "../.jig/connections/workspace.js"`
    )).toEqual(["workspace"])
  })

  it("extracts multiple servers", () => {
    const code = `
import { workspace } from "../.jig/connections/workspace.js"
import { granola } from "../.jig/connections/granola.js"
import { github } from "../.jig/connections/github.js"`
    expect(extractImportedServers(code)).toEqual(["workspace", "granola", "github"])
  })

  it("handles nested relative import depth", () => {
    expect(extractImportedServers(
      `import { workspace } from "../../.jig/connections/workspace.js"`
    )).toEqual(["workspace"])
  })

  it("returns empty for no connections", () => {
    expect(extractImportedServers(
      `import { jig, run } from "../src/index.js"`
    )).toEqual([])
  })

  it("extracts alias-based connection imports", () => {
    expect(extractImportedServers(
      `import { apify } from "@jig/connections/apify.js"`
    )).toEqual(["apify"])
  })

  it("extracts extensionless connection imports", () => {
    expect(extractImportedServers(
      `import { workspace } from "@jig/connections/workspace"`
    )).toEqual(["workspace"])
  })
})

describe("hasExplicitEmptyToolsArray", () => {
  it("detects an explicitly empty tools array", () => {
    expect(hasExplicitEmptyToolsArray(`export default jig("x", { tools: [] }, async () => {})`)).toBe(true)
  })

  it("does not flag non-empty tools arrays", () => {
    expect(hasExplicitEmptyToolsArray(`export default jig("x", { tools: [apify.call_actor] }, async () => {})`)).toBe(false)
  })

  it("does not flag code without a tools property", () => {
    expect(hasExplicitEmptyToolsArray(`export default jig("x", { trigger: { type: "manual" } }, async () => {})`)).toBe(false)
  })
})

describe("collectBuildTimeToolPolicyIssues", () => {
  const apifyResolution = {
    server: "apify",
    context: 'Resolved Apify Actor at build time for this workflow: community/github-trending-scraper.',
    requiredTools: ["call-actor"],
    includeTools: ["call-actor", "get-actor-run", "get-actor-output"],
    excludeTools: ["search-actors", "fetch-actor-details"],
    resolvedTarget: "community/github-trending-scraper",
    resolvedInputSchema: {
      type: "object",
      properties: {
        since: { type: "string" },
        language: { type: "string" },
      },
      required: ["since"],
    },
  }

  it("flags runtime rediscovery tools after build-time resolution", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.search_actors, apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.search_actors, apify.call_actor], async () => {
    await apify.search_actors({ keywords: "github trending" })
    await apify.call_actor({ actor: "community/github-trending-scraper", input: { since: "weekly" } })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [apifyResolution])).toEqual([
      {
        server: "apify",
        message: "Do not use apify.search_actors at runtime here. Build-time discovery already resolved the target, so keep runtime code on concrete execution tools only.",
      },
    ])
  })

  it("flags code that never uses the required concrete runtime tool", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.search_actors] }, async (ctx) => {
  await ctx.step("Run", [apify.search_actors], async () => {
    await apify.search_actors({ keywords: "github trending" })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [apifyResolution])).toContainEqual({
      server: "apify",
      message: "Build-time discovery already resolved the runtime target. This code must use the required runtime tools for apify: call-actor.",
    })
  })

  it("still requires call_actor even if a follow-up runtime tool is used", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.get_actor_output] }, async (ctx) => {
  await ctx.step("Run", [apify.get_actor_output], async () => {
    await apify.get_actor_output({ datasetId: "abc123" })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [apifyResolution])).toContainEqual({
      server: "apify",
      message: "Build-time discovery already resolved the runtime target. This code must use the required runtime tools for apify: call-actor.",
    })
  })

  it("accepts concrete runtime code that only uses the selected execution tool", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    await apify.call_actor({ actor: "community/github-trending-scraper", input: { since: "weekly" } })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [apifyResolution])).toEqual([])
  })

  it("accepts resolved Apify input fields passed through a local object variable", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    const input = { since: ctx.params.since, language: "typescript" }
    await apify.call_actor({ actor: "community/github-trending-scraper", input })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [apifyResolution])).toEqual([])
  })

  it("rejects a different Apify actor when build-time discovery already resolved one", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    await apify.call_actor({ actorId: "apify/hello-world", input: "{}" })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [apifyResolution])).toContainEqual({
      server: "apify",
      message: 'Build-time discovery resolved the Apify actor to "community/github-trending-scraper". This code must call that exact actor instead of substituting a different one or a placeholder.',
    })
  })

  it("rejects apify.call_actor calls that use the wrong top-level params", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    await apify.call_actor({ actorId: "community/github-trending-scraper", input: JSON.stringify({ since: "weekly" }) })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [apifyResolution])).toContainEqual({
      server: "apify",
      message: "Use apify.call_actor with the MCP tool's exact params: pass `actor`, not `actorId`.",
    })
    expect(collectBuildTimeToolPolicyIssues(code, [apifyResolution])).toContainEqual({
      server: "apify",
      message: "Use apify.call_actor with a real object for `input`. Do not pass JSON strings or JSON.stringify(...).",
    })
  })

  it("rejects missing required Apify actor input fields from build-time discovery", () => {
    const code = `
import { jig } from "@jig/sdk"
import { apify } from "@jig/connections/apify.js"

export default jig("x", { tools: [apify.call_actor] }, async (ctx) => {
  await ctx.step("Run", [apify.call_actor], async () => {
    await apify.call_actor({ actor: "community/github-trending-scraper", input: { language: "typescript" } })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [apifyResolution])).toContainEqual({
      server: "apify",
      message: "Build-time discovery resolved required Apify actor input fields: since. The apify.call_actor input must provide them directly or map them from jig params/context.",
    })
  })
})

describe("deriveAuthoringServerScope", () => {
  it("keeps imported servers in the required connection set for edits", () => {
    expect(deriveAuthoringServerScope(["github"], ["apify"])).toEqual({
      allServers: ["github", "apify"],
      newServers: ["apify"],
      buildResolutionServers: ["apify"],
    })
  })

  it("treats planned servers as the full scope when there is no existing code", () => {
    expect(deriveAuthoringServerScope([], ["apify", "github"])).toEqual({
      allServers: ["apify", "github"],
      newServers: ["apify", "github"],
      buildResolutionServers: ["apify", "github"],
    })
  })
})

describe("Context.output", () => {
  it("captures output", () => {
    const ctx = new Context({}, [])
    ctx.setSink(() => {}) // silence console
    ctx.output("hello")
    ctx.output("world", 42)
    expect(ctx.getOutput()).toEqual(["hello", "world 42"])
  })

  it("defaults to console.log", () => {
    const logged: string[] = []
    const ctx = new Context({}, [])
    ctx.setSink((...args: any[]) => logged.push(args.join(" ")))
    ctx.output("test")
    expect(logged).toEqual(["test"])
    expect(ctx.getOutput()).toEqual(["test"])
  })
})

describe("run()", () => {
  it("returns context with captured output", async () => {
    const testJig = jig("test", {}, async (ctx) => {
      ctx.output("line 1")
      ctx.output("line 2")
    })
    const ctx = await run(testJig)
    expect(ctx.getOutput()).toEqual(["line 1", "line 2"])
  })

  it("silent mode suppresses sink but still captures", async () => {
    const sinkCalls: string[] = []
    const origLog = console.log
    console.log = (...args: any[]) => sinkCalls.push(args.join(" "))

    const testJig = jig("test", {}, async (ctx) => {
      ctx.output("hidden")
    })
    const ctx = await run(testJig, {}, { silent: true })

    console.log = origLog
    expect(ctx.getOutput()).toEqual(["hidden"])
    expect(sinkCalls).toEqual([]) // nothing went to console
  })

  it("passes params to handler", async () => {
    let received: Record<string, string> = {}
    const testJig = jig("test", { params: { name: "Your name" } }, async (ctx) => {
      received = ctx.params
    })
    await run(testJig, { name: "Alice" })
    expect(received).toEqual({ name: "Alice" })
  })
})

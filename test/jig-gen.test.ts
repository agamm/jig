import { describe, it, expect } from "bun:test"
import {
  stripCodeFences,
  extractImportedServers,
  hasExplicitEmptyToolsArray,
  collectBuildTimeToolPolicyIssues,
  deriveAuthoringServerScope,
  extractReferencedToolNames,
  normalizeSelectedToolNames,
  missingConnectionsMessage,
  blockingUnknownConnections,
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
      `import { workspace } from "@jig/connections/workspace.js"`
    )).toEqual(["workspace"])
  })

  it("extracts multiple servers", () => {
    const code = `
import { workspace } from "@jig/connections/workspace.js"
import { granola } from "@jig/connections/granola.js"
import { github } from "@jig/connections/github.js"`
    expect(extractImportedServers(code)).toEqual(["workspace", "granola", "github"])
  })

  it("returns empty for no connections", () => {
    expect(extractImportedServers(
      `import { jig, run } from "@jig/sdk"`
    )).toEqual([])
  })

  it("extracts extensionless connection imports", () => {
    expect(extractImportedServers(
      `import { workspace } from "@jig/connections/workspace"`
    )).toEqual(["workspace"])
  })

  it("ignores relative connection paths — the runner rejects those jigs outright", () => {
    expect(extractImportedServers(
      `import { workspace } from "../.jig/connections/workspace.js"`
    )).toEqual([])
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
  const genericResolution = {
    server: "example",
    context: "Resolved Example target at build time for this workflow.",
    requiredTools: ["run-task"],
    includeTools: ["run-task", "read-result"],
    excludeTools: ["discover-task"],
  }

  it("flags runtime rediscovery tools after build-time resolution", () => {
    const code = `
import { jig } from "@jig/sdk"
import { example } from "@jig/connections/example.js"

export default jig("x", { tools: [example.discover_task, example.run_task] }, async (ctx) => {
  await ctx.step("Run", [example.discover_task, example.run_task], async () => {
    await example.discover_task({ query: "github trending" })
    await example.run_task({ target: "trending" })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [genericResolution])).toEqual([
      {
        server: "example",
        message: "Do not use example.discover_task at runtime here. Build-time discovery already resolved the target, so keep runtime code on concrete execution tools only.",
      },
    ])
  })

  it("flags code that never uses the required concrete runtime tool", () => {
    const code = `
import { jig } from "@jig/sdk"
import { example } from "@jig/connections/example.js"

export default jig("x", { tools: [example.read_result] }, async (ctx) => {
  await ctx.step("Run", [example.read_result], async () => {
    await example.read_result({ target: "trending" })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [genericResolution])).toContainEqual({
      server: "example",
      message: "Build-time discovery already resolved the runtime target. This code must use the required runtime tools for example: run-task.",
    })
  })

  it("accepts code that uses an allowed runtime tool alongside the required one", () => {
    const code = `
import { jig } from "@jig/sdk"
import { example } from "@jig/connections/example.js"

export default jig("x", { tools: [example.run_task, example.read_result] }, async (ctx) => {
  await ctx.step("Run", [example.run_task, example.read_result], async () => {
    await example.run_task({ target: "trending" })
    await example.read_result({ target: "trending" })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [genericResolution])).toEqual([])
  })

  it("accepts concrete runtime code that only uses the required execution tool", () => {
    const code = `
import { jig } from "@jig/sdk"
import { example } from "@jig/connections/example.js"

export default jig("x", { tools: [example.run_task] }, async (ctx) => {
  await ctx.step("Run", [example.run_task], async () => {
    await example.run_task({ target: "trending" })
  })
})
`

    expect(collectBuildTimeToolPolicyIssues(code, [genericResolution])).toEqual([])
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

describe("extractReferencedToolNames", () => {
  it("scopes existing edit prompts to tools referenced by the current code", () => {
    const code = `
import { workspace } from "@jig/connections/workspace.js"
import { apify } from "@jig/connections/apify.js"

await workspace.gmail_search({ query: "subject:update" })
await workspace.gmail_get({ id: "abc" })
await apify.call_actor({ actor: "apify/hello-world", input: {} })
`

    expect(extractReferencedToolNames(code, ["workspace", "apify"])).toEqual([
      "gmail_search",
      "gmail_get",
      "call-actor",
    ])
  })

  it("dedupes repeated references and ignores unknown tool identifiers", () => {
    const code = `
await workspace.gmail_search({ query: "a" })
await workspace.gmail_search({ query: "b" })
await workspace.not_a_real_tool({})
`

    expect(extractReferencedToolNames(code, ["workspace"])).toEqual(["gmail_search"])
  })
})

describe("normalizeSelectedToolNames", () => {
  it("maps code-facing identifiers back to runtime tool names", () => {
    expect(normalizeSelectedToolNames(["get_dataset_items"], ["get-dataset-items"])).toEqual(["get-dataset-items"])
  })

  it("filters hallucinated names when at least one selected tool is valid", () => {
    expect(normalizeSelectedToolNames(["search_emails", "gmail_search"], ["gmail_search", "gmail_get"])).toEqual(["gmail_search"])
  })

  it("falls back to all available non-excluded tools when every selected name is invalid", () => {
    expect(normalizeSelectedToolNames(["search_emails"], ["gmail_search", "gmail_get", "gmail_send"], ["gmail_send"])).toEqual([
      "gmail_search",
      "gmail_get",
    ])
  })
})

describe("Context.output", () => {
  it("captures output", () => {
    const ctx = new Context({})
    ctx.setSink(() => {}) // silence console
    ctx.output("hello")
    ctx.output("world", 42)
    expect(ctx.getOutput()).toEqual(["hello", "world 42"])
  })

  it("defaults to console.log", () => {
    const logged: string[] = []
    const ctx = new Context({})
    ctx.setSink((...args: any[]) => logged.push(args.join(" ")))
    ctx.output("test")
    expect(logged).toEqual(["test"])
    expect(ctx.getOutput()).toEqual(["test"])
  })
})

describe("run()", () => {
  it("returns context with captured output", async () => {
    const testJig = jig("test", { trigger: { type: "manual" } }, async (ctx) => {
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

    const testJig = jig("test", { trigger: { type: "manual" } }, async (ctx) => {
      ctx.output("hidden")
    })
    const ctx = await run(testJig, {}, { silent: true })

    console.log = origLog
    expect(ctx.getOutput()).toEqual(["hidden"])
    expect(sinkCalls).toEqual([]) // nothing went to console
  })

  it("passes params to handler", async () => {
    let received: Record<string, unknown> = {}
    const testJig = jig("test", { trigger: { type: "manual" } }, async (ctx) => {
      received = ctx.params
    })
    await run(testJig, { name: "Alice" })
    expect(received).toEqual({ name: "Alice" })
  })
})

describe("missingConnectionsMessage", () => {
  it("names unknown-only blockers", () => {
    expect(missingConnectionsMessage([], ["weather-api", "calendar"])).toBe(
      "This workflow needs connections jig doesn't have yet: weather-api, calendar"
    )
  })

  it("names known missing blockers", () => {
    expect(missingConnectionsMessage(["github"], [])).toBe(
      "Required connections are not set up: github"
    )
  })

  it("names both known missing and unknown blockers", () => {
    expect(missingConnectionsMessage(["github"], ["calendar"])).toBe(
      "Required connections are not set up: github. Also needs connectors jig doesn't have: calendar"
    )
  })
})

describe("blockingUnknownConnections", () => {
  const configs = {
    apify: { authoringDiscovery: "src/mcp/discover/apify.ts" },
    github: {},
  }
  const connected = (name: string) => name === "apify"

  it("blocks capability unknowns when no discovery server is selected", () => {
    expect(
      blockingUnknownConnections(["weather data source"], ["github"], configs, { isConnected: connected })
    ).toEqual(["weather data source"])
  })

  it("defers capability unknowns when a connected discovery server is selected", () => {
    expect(
      blockingUnknownConnections(["weather_data_source", "weather data source"], ["apify"], configs, {
        isConnected: connected,
      })
    ).toEqual([])
  })

  it("defers invented server keys when a connected discovery server is selected", () => {
    expect(
      blockingUnknownConnections(["weather_api"], ["apify"], configs, {
        isConnected: connected,
        invalidServerKeys: ["weather_data_source", "notion"],
      })
    ).toEqual([])
  })

  it("blocks invented server keys when no discovery server is selected", () => {
    expect(
      blockingUnknownConnections([], ["github"], configs, {
        isConnected: connected,
        invalidServerKeys: ["weather_data_source"],
      })
    ).toEqual(["weather_data_source"])
  })

  it("keeps capability unknowns when the discovery server is not connected", () => {
    expect(
      blockingUnknownConnections(["weather_api"], ["apify"], configs, {
        isConnected: () => false,
        invalidServerKeys: ["weather_data_source"],
      })
    ).toEqual(["weather_api", "weather_data_source"])
  })
})

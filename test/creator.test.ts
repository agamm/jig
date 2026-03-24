import { describe, it, expect } from "vitest"
import { stripCodeFences, extractImportedServers } from "../src/creator.js"
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

  it("handles grouped jig import depth", () => {
    expect(extractImportedServers(
      `import { workspace } from "../../.jig/connections/workspace.js"`
    )).toEqual(["workspace"])
  })

  it("returns empty for no connections", () => {
    expect(extractImportedServers(
      `import { jig, run } from "../src/index.js"`
    )).toEqual([])
  })
})

describe("Context.log", () => {
  it("captures output", () => {
    const ctx = new Context({}, [])
    ctx.setSink(() => {}) // silence console
    ctx.log("hello")
    ctx.log("world", 42)
    expect(ctx.getOutput()).toEqual(["hello", "world 42"])
  })

  it("defaults to console.log", () => {
    const logged: string[] = []
    const ctx = new Context({}, [])
    ctx.setSink((...args: any[]) => logged.push(args.join(" ")))
    ctx.log("test")
    expect(logged).toEqual(["test"])
    expect(ctx.getOutput()).toEqual(["test"])
  })
})

describe("run()", () => {
  it("returns context with captured output", async () => {
    const testJig = jig("test", {}, async (ctx) => {
      ctx.log("line 1")
      ctx.log("line 2")
    })
    const ctx = await run(testJig)
    expect(ctx.getOutput()).toEqual(["line 1", "line 2"])
  })

  it("silent mode suppresses sink but still captures", async () => {
    const sinkCalls: string[] = []
    const origLog = console.log
    console.log = (...args: any[]) => sinkCalls.push(args.join(" "))

    const testJig = jig("test", {}, async (ctx) => {
      ctx.log("hidden")
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

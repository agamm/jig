import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { buildJsonSchema } from "../src/sdk/llm.js"

/**
 * The bug these guard: `schema: { servers: "array" }` typechecks (the string is a
 * legal JSON Schema type name) but throws at call time, and the two worst
 * offenders sat behind `as any` in the jig planner. Every "write me a jig"
 * request died on it.
 */
describe("schemas passed to llm()/agent()", () => {
  it("accepts the shapes the jig planner and apify discovery now use", () => {
    expect(() =>
      buildJsonSchema({ servers: ["string"], unknownServers: ["string"], name: "string", needsIntegration: "boolean" }),
    ).not.toThrow()
    expect(() => buildJsonSchema({ tools: ["string"] })).not.toThrow()
    expect(() => buildJsonSchema({ actors: [{ fullName: "string", totalUsers: "number" }] })).not.toThrow()
  })

  it("still rejects a bare array, which is what broke", () => {
    expect(() => buildJsonSchema({ servers: "array" } as never)).toThrow(/needs an item shape/)
  })

  it("leaves no bare array or object schema in the source", () => {
    // Source-level because `as any` defeats the type system here, and the
    // failure only shows up at runtime in front of a user.
    const offenders: string[] = []
    for (const file of ["src/jig-gen.ts", "src/mcp/discover/apify.ts", "src/services/agent-service.ts"]) {
      const source = readFileSync(file, "utf-8")
      for (const [i, line] of source.split("\n").entries()) {
        if (/schema:/.test(line) && /:\s*"(array|object)"/.test(line)) offenders.push(`${file}:${i + 1}`)
      }
    }
    expect(offenders).toEqual([])
  })
})

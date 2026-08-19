import { describe, expect, it } from "bun:test"
import { parseToolArgs } from "../src/cli-debug/eval-args.js"

describe("parseToolArgs", () => {
  it("treats a missing --args as no arguments", () => {
    expect(parseToolArgs(undefined)).toEqual({ ok: true, value: {} })
  })

  it("parses an object", () => {
    expect(parseToolArgs('{"max_results":3}')).toEqual({ ok: true, value: { max_results: 3 } })
  })

  // Without this the raw SyntaxError surfaces as "Unexpected token }", which
  // says nothing about which flag was wrong or what it should have contained.
  it("names the flag when the JSON is malformed", () => {
    const out = parseToolArgs("{max_results: 3}")
    expect(out.ok).toBe(false)
    expect(out.ok === false && out.error).toContain("--args")
  })

  // MCP tool arguments are always a named map. An array or scalar would be
  // forwarded and rejected by the server with a much vaguer message.
  it("rejects JSON that is not an object", () => {
    expect(parseToolArgs("[1,2]").ok).toBe(false)
    expect(parseToolArgs('"hi"').ok).toBe(false)
    expect(parseToolArgs("null").ok).toBe(false)
  })

  it("accepts an explicitly empty object", () => {
    expect(parseToolArgs("{}")).toEqual({ ok: true, value: {} })
  })
})

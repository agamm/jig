import { describe, expect, it } from "bun:test"
import { buildJsonSchema } from "../src/sdk/llm.js"

describe("buildJsonSchema", () => {
  it("builds a strict object from primitive leaves", () => {
    expect(buildJsonSchema({ pct: "number", label: "string" })).toEqual({
      type: "object",
      properties: { pct: { type: "number" }, label: { type: "string" } },
      required: ["pct", "label"],
      additionalProperties: false,
    })
  })

  // post-meeting-coach declared `improvements: "any"`. The old builder emitted
  // {"type":"any"}, so the provider 400'd with "'any' is not valid under any of
  // the given schemas" AFTER the model had already produced the analysis.
  it("rejects 'any' with a message that says what to write instead", () => {
    expect(() => buildJsonSchema({ improvements: "any" })).toThrow(/not a JSON Schema type/)
    expect(() => buildJsonSchema({ improvements: "any" })).toThrow(/describe the real shape/)
  })

  it("rejects any other non-type string", () => {
    expect(() => buildJsonSchema({ when: "date" })).toThrow(/schema.when/)
  })

  it("expresses an array of objects, which the flat mini-language could not", () => {
    expect(buildJsonSchema({ items: [{ nudge: "string" }] })).toEqual({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: {
            type: "object",
            properties: { nudge: { type: "string" } },
            required: ["nudge"],
            additionalProperties: false,
          },
        },
      },
      required: ["items"],
      additionalProperties: false,
    })
  })

  it("nests plain objects", () => {
    const out = buildJsonSchema({ meta: { id: "string" } }) as any
    expect(out.properties.meta.type).toBe("object")
    expect(out.properties.meta.additionalProperties).toBe(false)
  })

  it("refuses a multi-element array shorthand", () => {
    expect(() => buildJsonSchema({ xs: [{ a: "string" }, { b: "string" }] as any })).toThrow(/exactly one element/)
  })
})

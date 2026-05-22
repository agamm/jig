import { describe, expect, it } from "bun:test"
import { collectShapeWarnings } from "../src/services/introspect.js"
import type { Shape } from "../src/services/introspect.js"

const stubShape: Shape = { type: "object", keys: {} }

describe("collectShapeWarnings", () => {
  it("returns no warnings on clean structures", () => {
    const out = collectShapeWarnings({ messages: [{ id: 1 }, { id: 2 }] }, stubShape)
    expect(out).toEqual([])
  })

  it("flags '...N more items' sentinel strings anywhere in the tree", () => {
    const out = collectShapeWarnings(
      { messages: [{ id: 1 }, { id: 2 }, "...18 more items"] },
      stubShape,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/sentinel string/i)
    expect(out[0]).toMatch(/Re-introspect with smaller args/i)
  })

  it("counts sentinels across nested arrays", () => {
    const out = collectShapeWarnings(
      {
        messages: [
          { id: 1, labels: ["UNREAD", "...3 more items"] },
          { id: 2, labels: ["INBOX"] },
          "...18 more items",
        ],
      },
      stubShape,
    )
    expect(out).toHaveLength(1)
    expect(out[0]).toMatch(/\b2\b/)
  })

  it("handles the unicode ellipsis form '…N more items'", () => {
    const out = collectShapeWarnings({ messages: ["…5 more items"] }, stubShape)
    expect(out).toHaveLength(1)
  })

  it("does not flag normal strings that contain 'more items'", () => {
    const out = collectShapeWarnings(
      { subject: "We have 18 more items in stock!" },
      stubShape,
    )
    expect(out).toEqual([])
  })

  it("tolerates circular references without infinite-looping", () => {
    const obj: any = { name: "x" }
    obj.self = obj
    expect(() => collectShapeWarnings(obj, stubShape)).not.toThrow()
  })
})

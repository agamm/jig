import { describe, expect, it } from "bun:test"
import { firstLineSummary } from "../src/text.js"

describe("firstLineSummary", () => {
  it("returns the first non-empty trimmed line", () => {
    expect(firstLineSummary("\nSearch the Apify Store\nMore detail")).toBe("Search the Apify Store")
  })

  it("returns an empty string for blank input", () => {
    expect(firstLineSummary(" \n \n")).toBe("")
  })
})

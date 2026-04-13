import { describe, expect, it } from "bun:test"
import { renderCodeFacingToolCatalogSection } from "../src/tool-catalog.js"

describe("renderCodeFacingToolCatalogSection", () => {
  it("renders code-facing names and preserves the raw MCP name when needed", () => {
    const section = renderCodeFacingToolCatalogSection("apify", [
      { name: "search-actors", description: "\nSearch the Apify Store\nMore detail" },
    ])

    expect(section).toContain('apify.search_actors (MCP tool: "search-actors"): Search the Apify Store')
  })
})

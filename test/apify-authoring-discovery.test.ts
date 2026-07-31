import { describe, expect, it } from "bun:test"
import { resolveForBuildWithOps } from "../src/mcp/discover/apify.js"

describe("apify authoring discovery", () => {
  it("resolves a concrete actor and biases runtime toward call-actor", async () => {
    const llmCalls: Array<{ prompt: string; data: Record<string, unknown> }> = []
    const result = await resolveForBuildWithOps({
      description: "Create a jig to find trending GitHub repositories with Apify",
      connection: {} as any,
      ask: async () => {
        throw new Error("ask() should not be called for a high-confidence single choice")
      },
    }, {
      callTool: async (_connection, toolName, args) => {
        if (toolName === "search-actors") {
          return `
# Search results:
## [GitHub Trending Scraper](https://apify.com/community/github-trending-scraper) (\`community/github-trending-scraper\`)
- **Description:** Scrapes trending GitHub repositories by timeframe.
- **Stats:** 12,000 total users, 850 monthly users, Runs succeeded: 98.7%, 420 bookmarks
- **Rating:** 4.9 out of 5
`
        }

        if (toolName === "fetch-actor-details") {
          expect(args).toEqual({
            actor: "community/github-trending-scraper",
            output: {
              description: true,
              inputSchema: true,
              outputSchema: true,
              metadata: true,
              stats: true,
              rating: true,
            },
          })

          return `# Actor information
## [GitHub Trending Scraper](https://apify.com/community/github-trending-scraper) (\`community/github-trending-scraper\`)
- **Description:** Scrapes trending GitHub repositories by timeframe.
- **Stats:** 12,000 total users, 850 monthly users, Runs succeeded: 98.7%, 420 bookmarks
- **Rating:** 4.9 out of 5

# [Input schema](https://apify.com/community/github-trending-scraper/input)
\`\`\`json
{"type":"object","properties":{"since":{"type":"string"},"language":{"type":"string"}}}
\`\`\`

# [Output schema](https://apify.com/community/github-trending-scraper/output)
\`\`\`json
{"type":"object","properties":{"items":{"type":"array"}}}
\`\`\``
        }

        throw new Error(`Unexpected tool call: ${toolName}`)
      },
      llm: async <T>(prompt: string, data: Record<string, unknown>) => {
        llmCalls.push({ prompt, data })

        if (prompt.includes("Choose one short Apify Store search query")) {
          return { query: "github trending" } as T
        }

        if (prompt.includes("Extract structured Apify Actor search results from markdown")) {
          return {
            actors: [{
              fullName: "community/github-trending-scraper",
              title: "GitHub Trending Scraper",
              description: "Scrapes trending GitHub repositories by timeframe.",
              url: "https://apify.com/community/github-trending-scraper",
              totalUsers: 12000,
              monthlyUsers: 850,
              successRate: 98.7,
              bookmarks: 420,
              rating: 4.9,
            }],
          } as T
        }

        if (prompt.includes("Extract structured Apify Actor details from markdown")) {
          return {
            actorInfo: {
              fullName: "community/github-trending-scraper",
              title: "GitHub Trending Scraper",
              description: "Scrapes trending GitHub repositories by timeframe.",
              url: "https://apify.com/community/github-trending-scraper",
            },
            description: "Scrapes trending GitHub repositories by timeframe.",
            inputSchema: {
              type: "object",
              properties: {
                since: { type: "string" },
                language: { type: "string" },
              },
            },
            outputSchema: {
              type: "object",
              properties: {
                items: { type: "array" },
              },
            },
            totalUsers: 12000,
            monthlyUsers: 850,
            successRate: 98.7,
            bookmarks: 420,
            rating: 4.9,
          } as T
        }

        throw new Error(`Unexpected llm prompt: ${prompt.slice(0, 80)}`)
      },
    })

    expect(result).not.toBeNull()
    expect(result?.requiredTools).toEqual(["call-actor"])
    expect(result?.includeTools).toEqual(["call-actor", "get-dataset-items"])
    expect(result?.excludeTools).toEqual(["search-actors", "fetch-actor-details"])
    expect(result?.resolvedInputSchema).toEqual({
      type: "object",
      properties: {
        since: { type: "string" },
        language: { type: "string" },
      },
    })
    expect(result?.context).toContain('Resolved Apify Actor at build time for this workflow: community/github-trending-scraper.')
    expect(result?.context).toContain('`const run = await apify.call_actor({ actor: "community/github-trending-scraper", input: { ... } })`')
    expect(result?.context).toContain("apify.get_dataset_items")
    expect(result?.context).toContain("does NOT contain the scraped rows")
    expect(result?.context).toContain("Never derive a result from the run descriptor alone")
    expect(result?.context).toContain("two separate `ctx.step(...)` blocks")
    expect(result?.context).toContain("- since: string")
    expect(llmCalls.some((call) => call.prompt.includes("Choose one short Apify Store search query"))).toBe(true)
    expect(llmCalls.some((call) => call.prompt.includes("Extract structured Apify Actor search results from markdown"))).toBe(true)
    expect(llmCalls.some((call) => call.prompt.includes("Extract structured Apify Actor details from markdown"))).toBe(true)
  })

  it("falls back to the model-selected actor when an ask-user reply is blank", async () => {
    let askCount = 0

    const result = await resolveForBuildWithOps({
      description: "Create a jig to scrape GitHub trending repositories with the best-fitting Apify actor",
      connection: {} as any,
      ask: async () => {
        askCount++
        return "   "
      },
    }, {
      callTool: async (_connection, toolName, args) => {
        if (toolName === "search-actors") {
          return {
            actors: [
              {
                fullName: "popular/general-github",
                title: "Popular GitHub Scraper",
                description: "General GitHub scraping actor.",
                stats: { totalUsers: 20000, monthlyUsers: 1500, successRate: 99.1, bookmarks: 600 },
                rating: { value: 4.8 },
              },
              {
                fullName: "best/trending-github",
                title: "GitHub Trending Specialist",
                description: "Fetches trending GitHub repositories by timeframe.",
                stats: { totalUsers: 5000, monthlyUsers: 400, successRate: 98.5, bookmarks: 250 },
                rating: { value: 4.9 },
              },
            ],
          }
        }

        if (toolName === "fetch-actor-details") {
          if ((args as any)?.actor === "popular/general-github") {
            return {
              actorInfo: {
                fullName: "popular/general-github",
                title: "Popular GitHub Scraper",
                description: "General GitHub scraping actor.",
              },
              inputSchema: { type: "object", properties: { url: { type: "string" } } },
            }
          }

          return {
            actorInfo: {
              fullName: "best/trending-github",
              title: "GitHub Trending Specialist",
              description: "Fetches trending GitHub repositories by timeframe.",
            },
            inputSchema: { type: "object", properties: { since: { type: "string" } } },
          }
        }

        throw new Error(`Unexpected tool call: ${toolName}`)
      },
      llm: async <T>(prompt: string) => {
        if (prompt.includes("Choose one short Apify Store search query")) {
          return { query: "github trending" } as T
        }

        if (prompt.includes("Choose the best Apify Actor for implementing this automation at build time")) {
          return {
            actor: "best/trending-github",
            reason: "It directly matches GitHub trending by timeframe.",
            askUser: true,
          } as T
        }

        if (prompt.includes("Map the user's answer to one of the available Apify Actors")) {
          throw new Error("Blank answers should fall back to the model-selected actor without another LLM call")
        }

        throw new Error(`Unexpected llm prompt: ${prompt.slice(0, 80)}`)
      },
    })

    expect(askCount).toBe(1)
    expect(result).not.toBeNull()
    expect(result?.context).toContain("Resolved Apify Actor at build time for this workflow: best/trending-github.")
    expect(result?.context).toContain('`const run = await apify.call_actor({ actor: "best/trending-github", input: { ... } })`')
    expect(result?.context).toContain("apify.get_dataset_items")
  })

  it("uses the LLM fallback instead of substring matching for fuzzy user choices", async () => {
    let mapCalls = 0

    const result = await resolveForBuildWithOps({
      description: "Create a jig to scrape GitHub trending repositories with the best-fitting Apify actor",
      connection: {} as any,
      ask: async () => "trending github",
    }, {
      callTool: async (_connection, toolName, args) => {
        if (toolName === "search-actors") {
          return {
            actors: [
              {
                fullName: "popular/general-github",
                title: "Popular GitHub Scraper",
                description: "General GitHub scraping actor.",
              },
              {
                fullName: "best/trending-github",
                title: "GitHub Trending Specialist",
                description: "Fetches trending GitHub repositories by timeframe.",
              },
            ],
          }
        }

        if (toolName === "fetch-actor-details") {
          if ((args as any)?.actor === "popular/general-github") {
            return {
              actorInfo: {
                fullName: "popular/general-github",
                title: "Popular GitHub Scraper",
                description: "General GitHub scraping actor.",
              },
            }
          }

          return {
            actorInfo: {
              fullName: "best/trending-github",
              title: "GitHub Trending Specialist",
              description: "Fetches trending GitHub repositories by timeframe.",
            },
          }
        }

        throw new Error(`Unexpected tool call: ${toolName}`)
      },
      llm: async <T>(prompt: string) => {
        if (prompt.includes("Choose one short Apify Store search query")) {
          return { query: "github trending" } as T
        }

        if (prompt.includes("Choose the best Apify Actor for implementing this automation at build time")) {
          return {
            actor: "best/trending-github",
            reason: "It directly matches GitHub trending by timeframe.",
            askUser: true,
          } as T
        }

        if (prompt.includes("Map the user's answer to one of the available Apify Actors")) {
          mapCalls++
          return { actor: "best/trending-github" } as T
        }

        throw new Error(`Unexpected llm prompt: ${prompt.slice(0, 80)}`)
      },
    })

    expect(mapCalls).toBe(1)
    expect(result).not.toBeNull()
    expect(result?.resolvedTarget).toBe("best/trending-github")
  })

  it("accepts actor cards returned with id/name aliases and still resolves details", async () => {
    const result = await resolveForBuildWithOps({
      description: "manually trigger a github most trendy repos (from last week) via apify and output here.",
      connection: {} as any,
    }, {
      callTool: async (_connection, toolName, args) => {
        if (toolName === "search-actors") {
          return `
# Search results:
## [GitHub Trending Scraper](https://apify.com/automation-lab/github-trending-scraper) (\`automation-lab/github-trending-scraper\`)
- **Description:** Scrape GitHub Trending repositories by language and time range: today, this week, or this month.
- **Stats:** 16 total users, 10 monthly users, Runs succeeded: 96.4%
`
        }

        if (toolName === "fetch-actor-details") {
          expect(args).toEqual({
            actor: "automation-lab/github-trending-scraper",
            output: {
              description: true,
              inputSchema: true,
              outputSchema: true,
              metadata: true,
              stats: true,
              rating: true,
            },
          })
          return {
            actorInfo: {
              fullName: "automation-lab/github-trending-scraper",
              title: "GitHub Trending Scraper",
              description: "Scrape GitHub Trending repositories by language and time range: today, this week, or this month.",
            },
            inputSchema: {
              type: "object",
              properties: {
                since: { type: "string" },
              },
              required: ["since"],
            },
          }
        }

        throw new Error(`Unexpected tool call: ${toolName}`)
      },
      llm: async <T>(prompt: string) => {
        if (prompt.includes("Choose one short Apify Store search query")) {
          return { query: "github trending" } as T
        }

        if (prompt.includes("Extract structured Apify Actor search results from markdown")) {
          return {
            actors: [{
              name: "GitHub Trending Scraper",
              id: "automation-lab/github-trending-scraper",
              url: "https://apify.com/automation-lab/github-trending-scraper",
              description: "Scrape GitHub Trending repositories by language and time range: today, this week, or this month.",
              totalUsers: 16,
              monthlyUsers: 10,
              successRate: 96.4,
            }],
          } as T
        }

        if (prompt.includes("Choose the best Apify Actor for implementing this automation at build time")) {
          return {
            actor: "automation-lab/github-trending-scraper",
            reason: "It directly matches GitHub trending repositories with a weekly timeframe.",
            askUser: false,
          } as T
        }

        throw new Error(`Unexpected llm prompt: ${prompt.slice(0, 80)}`)
      },
    })

    expect(result).not.toBeNull()
    expect(result?.resolvedTarget).toBe("automation-lab/github-trending-scraper")
    expect(result?.context).toContain('`const run = await apify.call_actor({ actor: "automation-lab/github-trending-scraper", input: { ... } })`')
    expect(result?.context).toContain("apify.get_dataset_items")
  })

  it("accepts actor cards returned with actorId/name aliases and still resolves details", async () => {
    const result = await resolveForBuildWithOps({
      description: "manually trigger a github most trendy repos (from last week) via apify and output here.",
      connection: {} as any,
    }, {
      callTool: async (_connection, toolName, args) => {
        if (toolName === "search-actors") {
          return `
# Search results:
## [GitHub Trending Scraper](https://apify.com/automation-lab/github-trending-scraper) (\`automation-lab/github-trending-scraper\`)
- **Description:** Scrape GitHub Trending repositories by language and time range: today, this week, or this month.
- **Stats:** 16 total users, 10 monthly users, Runs succeeded: 96.4%
`
        }

        if (toolName === "fetch-actor-details") {
          expect(args).toEqual({
            actor: "automation-lab/github-trending-scraper",
            output: {
              description: true,
              inputSchema: true,
              outputSchema: true,
              metadata: true,
              stats: true,
              rating: true,
            },
          })
          return {
            actorInfo: {
              fullName: "automation-lab/github-trending-scraper",
              title: "GitHub Trending Scraper",
              description: "Scrape GitHub Trending repositories by language and time range: today, this week, or this month.",
            },
            inputSchema: {
              type: "object",
              properties: {
                since: { type: "string" },
              },
              required: ["since"],
            },
          }
        }

        throw new Error(`Unexpected tool call: ${toolName}`)
      },
      llm: async <T>(prompt: string) => {
        if (prompt.includes("Choose one short Apify Store search query")) {
          return { query: "github trending" } as T
        }

        if (prompt.includes("Extract structured Apify Actor search results from markdown")) {
          return {
            actors: [{
              name: "GitHub Trending Scraper",
              actorId: "automation-lab/github-trending-scraper",
              url: "https://apify.com/automation-lab/github-trending-scraper",
              description: "Scrape GitHub Trending repositories by language and time range: today, this week, or this month.",
              totalUsers: 16,
              monthlyUsers: 10,
              successRate: 96.4,
              categories: "Developer Tools, News",
            }],
          } as T
        }

        if (prompt.includes("Choose the best Apify Actor for implementing this automation at build time")) {
          return {
            actor: "automation-lab/github-trending-scraper",
            reason: "It directly matches GitHub trending repositories with a weekly timeframe.",
            askUser: false,
          } as T
        }

        throw new Error(`Unexpected llm prompt: ${prompt.slice(0, 80)}`)
      },
    })

    expect(result).not.toBeNull()
    expect(result?.resolvedTarget).toBe("automation-lab/github-trending-scraper")
    expect(result?.context).toContain('`const run = await apify.call_actor({ actor: "automation-lab/github-trending-scraper", input: { ... } })`')
    expect(result?.context).toContain("apify.get_dataset_items")
  })
})

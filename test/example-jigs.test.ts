import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { listExampleJigs } from "../src/services/example-jigs.js"
import { loadServerConfigs } from "../src/mcp/config.js"

const read = (id: string) => readFileSync(`examples/${id}.ts`, "utf-8")
const EXAMPLE_IDS = ["weekly-update", "pre-meeting-briefing", "executive-coach-daily"]

describe("example jig catalog", () => {
  it("loads durable example jigs from examples/", () => {
    const examples = listExampleJigs()
    const ids = examples.map((example) => example.id)

    for (const id of EXAMPLE_IDS) expect(ids).toContain(id)
    expect(examples.every((example) => example.steps.length > 0)).toBe(true)
    expect(examples.every((example) => example.trigger.length > 0)).toBe(true)
    expect(examples.every((example) => example.connections.length > 0)).toBe(true)
    expect(read("weekly-update")).not.toContain("params:")
  })

  it("only imports connections that are enabled in the default registry", async () => {
    // The bug this exists for: both briefing examples imported `workspace`,
    // which has been disabled in default.json since 2026-06-15. Adding one of
    // those examples installed an immediately-active jig that could never
    // resolve its import, and the old assertions pinned the broken names in
    // place. Read the registry instead of restating it.
    const available = new Set(Object.keys(await loadServerConfigs()))

    for (const id of EXAMPLE_IDS) {
      const imported = [...read(id).matchAll(/@jig\/connections\/([a-z0-9_-]+)\.js/g)].map((m) => m[1])
      expect(imported.length).toBeGreaterThan(0)
      for (const name of imported) {
        expect({ example: id, connection: name, enabled: available.has(name) }).toEqual({
          example: id,
          connection: name,
          enabled: true,
        })
      }
    }
  })

  it("imports connections with the .js specifier the authoring guide mandates", () => {
    for (const id of EXAMPLE_IDS) {
      const bare = [...read(id).matchAll(/@jig\/connections\/([a-z0-9_-]+)(?!\.js)["']/g)]
      expect({ example: id, bareImports: bare.map((m) => m[1]) }).toEqual({ example: id, bareImports: [] })
    }
  })

  it("uses the generated tool names, not the underlying provider spellings", () => {
    const weekly = read("weekly-update")
    const briefing = read("pre-meeting-briefing")
    const coach = read("executive-coach-daily")

    expect(weekly).toContain("agent<")
    expect(weekly).toContain("granola.query_granola_meetings")
    expect(briefing).toContain("granola.query_granola_meetings")
    expect(coach).toContain("granola.query_granola_meetings")
    expect(coach).toContain("composio.gmail_fetch_emails")

    // Provider-style spellings that do not exist on the generated clients.
    for (const [id, source] of EXAMPLE_IDS.map((id) => [id, read(id)] as const)) {
      for (const wrong of ["google_calendar_list_events", "gmail_search_emails", "google_drive_search", "gmail_create_draft"]) {
        expect({ example: id, wrong, present: source.includes(wrong) }).toEqual({ example: id, wrong, present: false })
      }
    }
  })

  it("does not tell the reader to discover their own identity at runtime", () => {
    // Personal constants are hardcoded: a lookup spends a tool call on
    // something that never changes, and examples get copied verbatim.
    for (const id of EXAMPLE_IDS) {
      for (const lookup of ["people_getMe", "gmail_get_profile", "get_account_info"]) {
        expect({ example: id, lookup, present: read(id).includes(lookup) }).toEqual({ example: id, lookup, present: false })
      }
    }
  })

  it("keeps every ctx.output call inside a step", () => {
    // Was a count (`toBe(1)`), which pinned the shape of one specific example
    // rather than the rule. Check the rule: an output outside a step escapes
    // the tool allowlist that steps exist to enforce.
    for (const id of EXAMPLE_IDS) {
      const source = read(id)
      expect(source).toContain("ctx.output(")

      let depth = 0
      let stepDepth: number | null = null
      const outsideStep: number[] = []
      source.split("\n").forEach((line, i) => {
        if (/ctx\.step\(/.test(line) && stepDepth === null) stepDepth = depth
        if (/ctx\.output\(/.test(line) && stepDepth === null) outsideStep.push(i + 1)
        depth += (line.match(/[{(]/g)?.length ?? 0) - (line.match(/[})]/g)?.length ?? 0)
        if (stepDepth !== null && depth <= stepDepth) stepDepth = null
      })

      expect({ example: id, outputsOutsideSteps: outsideStep }).toEqual({ example: id, outputsOutsideSteps: [] })
    }
  })
})

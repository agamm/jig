/**
 * Trigger parsing & editing — deterministic path (no LLM).
 *
 * Tests the REAL cronToText, textToTrigger, triggerToSource, and
 * replaceTriggerInSource from server.ts.
 */
import { describe, it, expect, afterEach } from "bun:test"
import { writeFileSync, readFileSync, rmSync, mkdtempSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { cronToText, textToTrigger, triggerToSource, replaceTriggerInSource } from "../src/domain/triggers.js"

// ---------------------------------------------------------------------------
// cronToText
// ---------------------------------------------------------------------------

describe("cronToText", () => {
  it("formats weekday cron", () => {
    expect(cronToText("0 9 * * 1")).toBe("Mon 9:00")
    expect(cronToText("30 14 * * 5")).toBe("Fri 14:30")
  })

  it("formats multi-day cron", () => {
    expect(cronToText("0 8 * * 1,3,5")).toBe("Mon, Wed, Fri 8:00")
  })

  it("formats daily cron", () => {
    expect(cronToText("0 9 * * *")).toBe("Daily 9:00")
    expect(cronToText("30 17 * * *")).toBe("Daily 17:30")
  })

  it("formats monthly cron", () => {
    expect(cronToText("0 9 15 * *")).toBe("15 of month 9:00")
    expect(cronToText("0 10 1 * *")).toBe("1 of month 10:00")
  })

  it("formats interval cron", () => {
    expect(cronToText("*/15 * * * *")).toBe("Every 15m")
    expect(cronToText("*/5 * * * *")).toBe("Every 5m")
  })
})

// ---------------------------------------------------------------------------
// textToTrigger
// ---------------------------------------------------------------------------

describe("textToTrigger", () => {
  it("parses manual and webhook", () => {
    expect(textToTrigger("manual")).toEqual({ type: "manual" })
    expect(textToTrigger("Manual")).toEqual({ type: "manual" })
    expect(textToTrigger("webhook")).toEqual({ type: "webhook" })
  })

  it("parses intervals as cron expressions", () => {
    expect(textToTrigger("every 30m")).toEqual({ type: "cron", cron: "*/30 * * * *" })
    expect(textToTrigger("every 5 minutes")).toEqual({ type: "cron", cron: "*/5 * * * *" })
    expect(textToTrigger("every 15 min")).toEqual({ type: "cron", cron: "*/15 * * * *" })
  })

  it("parses daily triggers", () => {
    expect(textToTrigger("daily 9am")).toEqual({ type: "cron", cron: "0 9 * * *" })
    expect(textToTrigger("every day at 14:30")).toEqual({ type: "cron", cron: "30 14 * * *" })
    expect(textToTrigger("daily morning")).toEqual({ type: "cron", cron: "0 9 * * *" })
  })

  it("parses day-of-week triggers", () => {
    expect(textToTrigger("mon 8:00")).toEqual({ type: "cron", cron: "0 8 * * 1" })
    expect(textToTrigger("friday 9am")).toEqual({ type: "cron", cron: "0 9 * * 5" })
    expect(textToTrigger("every monday at 9am")).toEqual({ type: "cron", cron: "0 9 * * 1" })
  })

  it("parses multi-day triggers", () => {
    expect(textToTrigger("mon,wed,fri 8:00")).toEqual({ type: "cron", cron: "0 8 * * 1,3,5" })
  })

  it("parses monthly triggers", () => {
    expect(textToTrigger("1st of month 9am")).toEqual({ type: "cron", cron: "0 9 1 * *" })
    expect(textToTrigger("15 of month 10:00")).toEqual({ type: "cron", cron: "0 10 15 * *" })
  })

  it("returns null for unparseable text", () => {
    expect(textToTrigger("")).toBe(null)
    expect(textToTrigger("some random garbage")).toBe(null)
    expect(textToTrigger("on gmail")).toBe(null) // event triggers no longer supported
  })

  it("handles time aliases", () => {
    expect(textToTrigger("mon morning")).toEqual({ type: "cron", cron: "0 9 * * 1" })
    expect(textToTrigger("friday noon")).toEqual({ type: "cron", cron: "0 12 * * 5" })
    expect(textToTrigger("daily midnight")).toEqual({ type: "cron", cron: "0 0 * * *" })
  })

  it("handles am/pm edge cases", () => {
    expect(textToTrigger("daily 2pm")).toEqual({ type: "cron", cron: "0 14 * * *" })
    expect(textToTrigger("daily 12pm")).toEqual({ type: "cron", cron: "0 12 * * *" })
    expect(textToTrigger("daily 12am")).toEqual({ type: "cron", cron: "0 0 * * *" })
  })
})

// ---------------------------------------------------------------------------
// triggerToSource
// ---------------------------------------------------------------------------

describe("triggerToSource", () => {
  it("serializes cron", () => {
    expect(triggerToSource({ type: "cron", cron: "0 9 * * 1" })).toBe('{ type: "cron", cron: "0 9 * * 1" }')
  })

  it("serializes manual and webhook", () => {
    expect(triggerToSource({ type: "manual" })).toBe('{ type: "manual" }')
    expect(triggerToSource({ type: "webhook" })).toBe('{ type: "webhook" }')
  })

  it("falls back to manual for unknown types", () => {
    expect(triggerToSource({ type: "interval" } as any)).toBe('{ type: "manual" }')
  })
})

// ---------------------------------------------------------------------------
// replaceTriggerInSource
// ---------------------------------------------------------------------------

describe("replaceTriggerInSource", () => {
  const makeCode = (trigger: string) => `
import { jig } from "../src/index.js"
export default jig("test", {
  trigger: ${trigger},
  connections: [],
}, async (ctx) => { ctx.output("done") })
`

  it("replaces cron trigger in source", () => {
    const code = makeCode('{ type: "cron", cron: "0 9 * * 1" }')
    const result = replaceTriggerInSource(code, '{ type: "cron", cron: "30 14 * * 5" }')

    expect(result).not.toBeNull()
    expect(result).toContain('cron: "30 14 * * 5"')
    expect(result).not.toContain('cron: "0 9 * * 1"')
    // Rest of file preserved
    expect(result).toContain('jig("test"')
    expect(result).toContain('ctx.output("done")')
  })

  it("replaces manual with cron", () => {
    const code = makeCode('{ type: "manual" }')
    const result = replaceTriggerInSource(code, '{ type: "cron", cron: "0 9 * * *" }')

    expect(result).toContain('cron: "0 9 * * *"')
    expect(result).not.toContain('"manual"')
  })

  it("returns null when no trigger found", () => {
    const code = `export default jig("test", { connections: [] }, async () => {})`
    expect(replaceTriggerInSource(code, '{ type: "manual" }')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Round-trip: textToTrigger → triggerToSource → replaceTriggerInSource
// ---------------------------------------------------------------------------

describe("trigger editing round-trip", () => {
  // Use a real OS temp dir — never write to project's jigs/
  const tmpDir = mkdtempSync(join(tmpdir(), "jig-trigger-test-"))
  const testJigPath = join(tmpDir, "_test_trigger_rt.ts")
  afterEach(() => { rmSync(testJigPath, { force: true }) })

  it("end-to-end: user types 'mon 8:00' → file gets cron trigger", () => {
    const original = `import { jig } from "../src/index.js"
export default jig("test", {
  trigger: { type: "manual" },
  connections: [],
}, async (ctx) => { ctx.output("done") })
`
    writeFileSync(testJigPath, original)

    // Same flow as handleUpdateTrigger:
    const parsed = textToTrigger("mon 8:00")
    expect(parsed).toEqual({ type: "cron", cron: "0 8 * * 1" })

    const source = triggerToSource(parsed!)
    const updated = replaceTriggerInSource(readFileSync(testJigPath, "utf-8"), source)

    expect(updated).not.toBeNull()
    writeFileSync(testJigPath, updated!)

    const final = readFileSync(testJigPath, "utf-8")
    expect(final).toContain('trigger: { type: "cron", cron: "0 8 * * 1" }')
    expect(final).not.toContain('"manual"')
    expect(final).toContain('ctx.output("done")')
  })

  it("cronToText displays what textToTrigger parsed", () => {
    // Parse → serialize → display should be coherent
    const inputs = ["mon 8:00", "daily 9am", "every 30m", "fri 2pm"]
    const expected = ["Mon 8:00", "Daily 9:00", "Every 30m", "Fri 14:00"]

    for (let i = 0; i < inputs.length; i++) {
      const parsed = textToTrigger(inputs[i])!
      expect(parsed.type).toBe("cron")
      expect(cronToText(parsed.cron!)).toBe(expected[i])
    }
  })
})

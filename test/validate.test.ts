import { describe, it, expect } from "bun:test"
import { validateDefinitionObject } from "../src/validate.js"

describe("validateDefinitionObject", () => {
  it("accepts a valid jig definition", () => {
    const result = validateDefinitionObject({
      name: "test-jig",
      options: {
        trigger: { type: "cron", cron: "0 8 * * 1" },
        tools: [],
      },
      handler: async () => {},
    })
    expect(result.ok).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.definition).toBeDefined()
  })

  it("rejects a jig without trigger", () => {
    const result = validateDefinitionObject({
      name: "no-trigger",
      options: { tools: [] },
      handler: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0].field).toBe("trigger")
  })

  it("accepts manual trigger (the default)", () => {
    const result = validateDefinitionObject({
      name: "manual-jig",
      options: { trigger: { type: "manual" }, tools: [] },
      handler: async () => {},
    })
    expect(result.ok).toBe(true)
  })

  it("accepts interval trigger", () => {
    const result = validateDefinitionObject({
      name: "poll-jig",
      options: { trigger: { type: "interval", minutes: 30 } },
      handler: async () => {},
    })
    expect(result.ok).toBe(true)
  })

  it("accepts event trigger", () => {
    const result = validateDefinitionObject({
      name: "event-jig",
      options: { trigger: { type: "event", source: "gmail.newEmail", filter: "urgent" } },
      handler: async () => {},
    })
    expect(result.ok).toBe(true)
  })

  it("rejects invalid cron expression", () => {
    const result = validateDefinitionObject({
      name: "bad-cron",
      options: { trigger: { type: "cron", cron: "not a cron" } },
      handler: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0].field).toBe("trigger.cron")
  })

  it("rejects cron trigger without cron field", () => {
    const result = validateDefinitionObject({
      name: "bad-cron",
      options: { trigger: { type: "cron" } },
      handler: async () => {},
    })
    expect(result.ok).toBe(false)
  })

  it("rejects interval with non-positive minutes", () => {
    const result = validateDefinitionObject({
      name: "bad-interval",
      options: { trigger: { type: "interval", minutes: 0 } },
      handler: async () => {},
    })
    expect(result.ok).toBe(false)
  })

  it("rejects interval above 59 minutes", () => {
    const result = validateDefinitionObject({
      name: "too-long-interval",
      options: { trigger: { type: "interval", minutes: 120 } },
      handler: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain("above 59 minutes")
  })

  it("rejects unknown trigger type", () => {
    const result = validateDefinitionObject({
      name: "bad-trigger",
      options: { trigger: { type: "magic" } },
      handler: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0].message).toContain("Unknown trigger type")
  })

  it("rejects missing name", () => {
    const result = validateDefinitionObject({
      options: {},
      handler: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0].field).toBe("name")
  })

  it("rejects missing handler", () => {
    const result = validateDefinitionObject({
      name: "no-handler",
      options: { trigger: { type: "manual" } },
    })
    expect(result.ok).toBe(false)
    expect(result.errors[0].field).toBe("handler")
  })

  it("rejects non-object default export", () => {
    const result = validateDefinitionObject("not an object")
    expect(result.ok).toBe(false)
  })
})

import { describe, it, expect } from "bun:test"
import { join } from "path"
import { PROJECT_ROOT } from "../src/config/paths.js"
import { rmSync, writeFileSync } from "fs"
import { validateDefinitionObject, validateJigFile } from "../src/validate.js"

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

  it("accepts webhook trigger", () => {
    const result = validateDefinitionObject({
      name: "webhook-jig",
      options: { trigger: { type: "webhook" } },
      handler: async () => {},
    })
    expect(result.ok).toBe(true)
  })

  it("rejects interval and event triggers (no longer supported)", () => {
    const interval = validateDefinitionObject({
      name: "poll-jig",
      options: { trigger: { type: "interval", minutes: 30 } },
      handler: async () => {},
    })
    expect(interval.ok).toBe(false)
    expect(interval.errors[0].message).toContain("Unknown trigger type")

    const event = validateDefinitionObject({
      name: "event-jig",
      options: { trigger: { type: "event", source: "gmail.newEmail" } },
      handler: async () => {},
    })
    expect(event.ok).toBe(false)
    expect(event.errors[0].message).toContain("Unknown trigger type")
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

  it("rejects declared jig params", () => {
    const result = validateDefinitionObject({
      name: "bad-params",
      options: {
        trigger: { type: "manual" },
        params: { name: "Your name" },
      },
      handler: async () => {},
    })
    expect(result.ok).toBe(false)
    expect(result.errors.some((error) => error.field === "options.params")).toBe(true)
  })
})

describe("validateJigFile", () => {
  it("rejects required tool params missing from statically inspectable calls", async () => {
    const jigPath = join(PROJECT_ROOT, "test", "_validate-missing-subject.ts")

    try {
      writeFileSync(jigPath, `
import { jig } from "../src/index.js"
import { workspace } from "../.jig/connections/workspace.js"

export default jig("missing-subject", {
  trigger: { type: "manual" },
  tools: [workspace.gmail_send],
}, async () => {
  await workspace.gmail_send({ to: "alerts@example.com", body: "hello" })
})
`)

      const result = await validateJigFile(jigPath)
      expect(result.ok).toBe(false)
      expect(result.errors).toContainEqual({
        field: "params.workspace.gmail_send.subject",
        message: 'Tool "workspace.gmail_send" is called without required parameter "subject".',
      })
    } finally {
      rmSync(jigPath, { force: true })
    }
  })

  it("rejects missing required params for sanitized tool identifiers via generated types", async () => {
    const jigPath = join(PROJECT_ROOT, "test", "_validate-missing-apify-input.ts")

    try {
      writeFileSync(jigPath, `
import { jig } from "../src/index.js"
import { apify } from "../.jig/connections/apify.js"

export default jig("missing-apify-input", {
  trigger: { type: "manual" },
  tools: [apify.call_actor],
}, async () => {
  await apify.call_actor({ actor: "apify/hello-world" })
})
`)

      const result = await validateJigFile(jigPath)
      expect(result.ok).toBe(false)
      expect(result.errors.some((error) => error.message.includes("input"))).toBe(true)
    } finally {
      rmSync(jigPath, { force: true })
    }
  })

  it("does not report missing params from unrelated shadowed variables", async () => {
    const jigPath = join(PROJECT_ROOT, "test", "_validate-shadowed-email.ts")

    try {
      writeFileSync(jigPath, `
import { jig } from "../src/index.js"
import { workspace } from "../.jig/connections/workspace.js"

const email = { to: "alerts@example.com", subject: "Alert", body: "outer" }

function unrelated() {
  const email = { to: "alerts@example.com", body: "inner" }
  return email
}

export default jig("shadowed-email", {
  trigger: { type: "manual" },
  tools: [workspace.gmail_send],
}, async () => {
  unrelated()
  await workspace.gmail_send(email)
})
`)

      const result = await validateJigFile(jigPath)
      expect(result.ok).toBe(true)
      expect(result.errors).toEqual([])
    } finally {
      rmSync(jigPath, { force: true })
    }
  })
})

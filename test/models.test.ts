/**
 * Three model slots: main (what jigs run llm()/agent() on), fast (classifiers),
 * writer (the reply-to-edit agent that edits jig code). The writer is a
 * separate slot so a strong coding model can be chosen without making every
 * jig run on it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { closeDb, openDb } from "../src/db.js"
import { DEFAULT_WRITER_MODEL, getModelCatalog, getWriterModel, setModelOverrides } from "../src/config/models.js"
import { MODEL_SLOTS } from "../shared/api.js"

beforeEach(() => { closeDb(); openDb(":memory:") })
afterEach(() => closeDb())

describe("writer model slot", () => {
  it("defaults to a strong coding model and can be overridden on its own", () => {
    expect(MODEL_SLOTS).toEqual(["main", "fast", "writer"])
    expect(getWriterModel()).toBe(DEFAULT_WRITER_MODEL)
    expect(DEFAULT_WRITER_MODEL).toMatch(/^anthropic\/|^openai\//)

    const catalog = setModelOverrides({ writer: "openai/gpt-5.5" })
    expect(getWriterModel()).toBe("openai/gpt-5.5")
    expect(catalog.writer.id).toBe("openai/gpt-5.5")
    expect(catalog.main.id).toBe(getModelCatalog().main.id)
    expect(catalog.defaults?.writer.id).toBe(DEFAULT_WRITER_MODEL)

    setModelOverrides({ writer: "" })
    expect(getWriterModel()).toBe(DEFAULT_WRITER_MODEL)
  })

  it("is what the reply-to-edit agent uses, never the runtime main model", () => {
    const source = readFileSync("src/services/agent-service.ts", "utf-8")
    expect(source).toContain("getWriterModel()")
    expect(source).not.toContain("getMainModel(")
  })
})

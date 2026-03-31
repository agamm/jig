import { describe, expect, it } from "bun:test"
import { extractPromptFromCommitBody } from "../src/services/jig-versioning"
import { buildCreatorJigPrompt } from "../src/services/jig-writing-prompt"

describe("jig version metadata", () => {
  it("extracts the saved prompt from the git commit body", () => {
    const body = [
      "jig: forgotten-emails — update prompt",
      "",
      "jig-meta:{\"prompt\":\"Tighten the prompt and keep the current tools.\"}",
      "",
    ].join("\n")

    expect(extractPromptFromCommitBody(body)).toBe("Tighten the prompt and keep the current tools.")
  })

  it("ignores malformed prompt metadata", () => {
    expect(extractPromptFromCommitBody("jig-meta:{not-json")).toBeNull()
    expect(extractPromptFromCommitBody("plain commit body")).toBeNull()
  })
})

describe("jig writing prompt policy", () => {
  it("tells edit flows to preserve tools unless the user asked to change them", () => {
    const prompt = buildCreatorJigPrompt({
      description: "Tighten the wording in the email summary output.",
      probeResults: "",
      importPrefix: "..",
      existingCode: "export default myJig",
      context: {
        skillMd: "",
        typeDefs: "",
        toolCatalog: "",
        relevantSchemas: "",
        exampleJig: "",
        serverDescriptions: "",
      },
    })

    expect(prompt).toContain("do NOT add or remove tools unless the user explicitly asked for tool changes")
  })
})

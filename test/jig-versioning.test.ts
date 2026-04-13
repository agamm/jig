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
  it("passes skillMd content through to the final prompt", () => {
    // The rules themselves now live in SKILL.md (single source of truth).
    // The composer's job is just to include skillMd in the prompt.
    const skillMd = "### Example rule\n- do NOT add or remove tools unless the user explicitly asked for tool changes"
    const prompt = buildCreatorJigPrompt({
      description: "Tighten the wording in the email summary output.",
      probeResults: "",
      importPrefix: "..",
      existingCode: "export default myJig",
      context: {
        skillMd,
        typeDefs: "",
        toolCatalog: "",
        buildHints: "",
        relevantSchemas: "",
        exampleJig: "",
        serverDescriptions: "",
      },
    })

    expect(prompt).toContain("do NOT add or remove tools unless the user explicitly asked for tool changes")
    // The composer points the model at the rules section instead of duplicating them.
    expect(prompt).toContain("Jig Writing Rules")
  })

  it("includes the real SKILL.md rules when loaded from disk", async () => {
    // Smoke test: the runtime agent path loads SKILL.md and passes it here.
    // This verifies the actual file contains the new "Jig Writing Rules" section.
    const skillMd = await Bun.file(`${import.meta.dir}/../SKILL.md`).text()
    expect(skillMd).toContain("Jig Writing Rules")
    expect(skillMd).toContain("ctx.step()")
    expect(skillMd).toContain("Steps MUST be flat")
  })
})

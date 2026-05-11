import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { extractPromptFromCommitBody } from "../src/services/jig-versioning"
import { buildCreatorJigPrompt } from "../src/services/jig-writing-prompt"
import { ensureJigsGitRepoAt } from "../src/services/jig-writer"

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

describe("jigs git history bootstrap", () => {
  it("initializes a jigs git repo with an initial snapshot commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-history-test-"))
    try {
      writeFileSync(join(dir, "example.ts"), "export default {}\n")

      await expect(ensureJigsGitRepoAt(dir)).resolves.toBe(true)
      expect(existsSync(join(dir, ".git"))).toBe(true)

      const log = Bun.spawnSync(["git", "log", "--format=%s", "--", "example.ts"], {
        cwd: dir,
      })
      expect(log.exitCode).toBe(0)
      expect(log.stdout.toString().trim()).toBe("Initial jig snapshot")

      const status = Bun.spawnSync(["git", "status", "--short"], { cwd: dir })
      expect(status.stdout.toString().trim()).toBe("")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
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

import { describe, expect, it } from "bun:test"

describe("jig writing prompt policy", () => {
  it("includes the real SKILL.md rules when loaded from disk", async () => {
    // Smoke test: the runtime agent path loads SKILL.md and passes it here.
    // This verifies the actual file contains the new "Jig Writing Rules" section.
    const skillMd = await Bun.file(`${import.meta.dir}/../SKILL.md`).text()
    expect(skillMd).toContain("Jig Writing Rules")
    expect(skillMd).toContain("ctx.step()")
    expect(skillMd).toContain("Steps MUST be flat")
  })
})

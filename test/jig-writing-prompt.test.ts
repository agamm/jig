import { describe, it, expect } from "vitest"
import { buildAgentJigSystemPrompt } from "../src/services/jig-writing-prompt.js"

const base = {
  jigId: "demo",
  skillMd: "",
  typeDefs: "",
  toolCatalog: "",
  relevantSchemas: "",
  serverDescriptions: "",
}

describe("buildAgentJigSystemPrompt — unavailable connections", () => {
  it("warns about imported-but-unconnected connections so the agent can ask or migrate", () => {
    const prompt = buildAgentJigSystemPrompt({
      ...base,
      currentCode: `import { workspace } from "@jig/connections/workspace"`,
      unavailableConnections: ["workspace"],
    })
    expect(prompt).toContain("Connections Not Set Up")
    expect(prompt).toContain("workspace")
    expect(prompt).toContain("ask_user")
  })

  it("omits the section when every imported connection is set up", () => {
    expect(buildAgentJigSystemPrompt({ ...base, unavailableConnections: [] }))
      .not.toContain("Connections Not Set Up")
    expect(buildAgentJigSystemPrompt(base)).not.toContain("Connections Not Set Up")
  })
})

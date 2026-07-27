import { describe, it, expect } from "vitest"
import { buildAgentJigSystemPrompt } from "../src/services/jig-writing-prompt.js"
import { PLAN_JIG_USER_EMAIL_RULE } from "../src/jig-gen.js"
import { readFileSync } from "fs"
import { join } from "path"

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

describe("authoring prefers ctx.email for user-directed mail", () => {
  it("puts ctx.email preference in agent hard rules", () => {
    const prompt = buildAgentJigSystemPrompt(base)
    expect(prompt).toContain("Prefer `ctx.email({ subject, text|html })`")
    expect(prompt).toContain("composio.gmail_send_email")
    expect(prompt).toContain("unless they explicitly asked for Gmail")
  })

  it("documents the planner rule against adding Gmail servers just to email the user", () => {
    expect(PLAN_JIG_USER_EMAIL_RULE).toContain("ctx.email")
    expect(PLAN_JIG_USER_EMAIL_RULE).toContain("do NOT add `composio`")
    expect(PLAN_JIG_USER_EMAIL_RULE).toContain("third parties")
  })

  it("SKILL.md defaults user-directed email to ctx.email", () => {
    const skill = readFileSync(join(import.meta.dirname, "..", "SKILL.md"), "utf-8")
    expect(skill).toContain('Default:** when the user says "email me"')
    expect(skill).toContain("use `ctx.email()` — not Gmail/Composio")
  })
})

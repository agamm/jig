type CreatorPromptInput = {
  description: string
  probeResults: string
  context: {
    skillMd: string
    typeDefs: string
    toolCatalog: string
    buildHints?: string
    relevantSchemas: string
    exampleJig: string
    serverDescriptions: string
  }
  existingCode?: string
}

type AgentPromptInput = {
  jigId?: string
  skillMd: string
  typeDefs: string
  toolCatalog: string
  relevantSchemas: string
  serverDescriptions: string
  buildHints?: string
  currentCode?: string
  exampleJig?: string
}

function joinSections(sections: Array<string | null | undefined>) {
  return sections.filter(Boolean).join("\n\n")
}

function section(title: string, body?: string | null) {
  const trimmed = body?.trim()
  if (!trimmed) return null
  return `## ${title}\n${trimmed}`
}

function connectionImportRules() {
  return `## Connection Import Rules
- Import each connection object from its connection module, for example: \`import { workspace } from "@jig/connections/workspace.js"\`.
- Use connection tools only through the imported connection object, for example: \`workspace.gmail_search(...)\` and \`tools: [workspace.gmail_search]\`.
- Never call bare tool names like \`gmail_search(...)\`, never rely on globals like \`workspace\` or \`composio\`, and never import individual tool functions from \`@jig/connections/*\`.`
}

function agentToolProtocol() {
  return `## Agent Tool Protocol
- Act immediately using the SKILL.md rules above as the single source of truth.
- If creating a new jig, choose a short valid jigId first and include it in your first write_jig_file call. Valid jigIds use lowercase letters, numbers, dashes, and underscores.
- Use the provided type definitions, tool catalog, schemas, and current code. Existing-edit prompts may include only the schemas for tools already referenced in the jig; call get_tool_schema when you need an exact schema that is not in the prompt.
- Do not browse local files or URLs to rediscover Jig-specific behavior already present in this prompt.
- After writing code, always run check_jig. If it reports errors, patch only the narrow issue and check again.
- Use web_search and browse only for external API docs not already in context.
- When done, reply with 1-2 short plain text sentences summarizing what changed. No markdown, no code blocks, no bullet points.`
}

export function buildCreatorJigPrompt({
  description,
  probeResults,
  context,
  existingCode,
}: CreatorPromptInput): string {
  return joinSections([
    "You are writing a TypeScript jig file that automates workflows.",
    context.typeDefs,
    context.skillMd,
    section("Available Connections", context.serverDescriptions),
    connectionImportRules(),
    section("Tool Catalog", context.toolCatalog),
    section("Build-Time Resolved Runtime Targets", context.buildHints),
    section("Tool Schemas (exact param names, types, required fields)", context.relevantSchemas),
    section("Probe Results (real data from the user's connected services)", probeResults),
    section("Example Jig (for reference)", `\`\`\`typescript\n${context.exampleJig}\n\`\`\``),
    existingCode ? section("Existing Jig Code (to modify)", `\`\`\`typescript\n${existingCode}\n\`\`\``) : null,
    existingCode
      ? section(
          "Edit Instruction",
          `${description}\n\nModify the existing jig code according to the instruction. Preserve the existing structure and only change what's needed.`
        )
      : section("Task", `Create a new jig that does the following:\n${description}`),
    context.buildHints
      ? `## Build-Time Resolution Policy
Any runtime target resolved above was discovered during jig creation, not during jig execution.

- Hardcode the resolved IDs, actor names, or resource identifiers directly into the generated jig
- Do NOT emit runtime rediscovery code for those targets
- Do NOT add back excluded search/meta-tools just because they exist on the connection
- Keep the jig focused on the selected runtime tools and concrete execution path`
      : null,
    `## Prompt Contract
Follow the **Jig Writing Rules** section in SKILL.md above. They are enforced by the runner and the static validator.`,
  ])
}

export function buildAgentJigSystemPrompt({
  jigId,
  skillMd,
  typeDefs,
  toolCatalog,
  relevantSchemas,
  serverDescriptions,
  buildHints,
  currentCode,
  exampleJig,
}: AgentPromptInput): string {
  return joinSections([
    `You are a jig creation and editing agent. You write TypeScript jig files that automate workflows.

IMPORTANT: Act immediately. Do NOT describe what you plan to do — just do it. The jig code is already in your context below, so do NOT call read_jig_file unless you need a different jig. Write the code, check it, and confirm in 1-2 sentences.

## Hard rules (don't violate)
- ctx.step() blocks must be FLAT. Never put ctx.step() inside another ctx.step() callback. Pass data between sibling steps via let-vars in the outer handler scope.
- Every connection tool used inside a step must appear in that step's tools array.`,
    skillMd,
    typeDefs,
    section("Available Connections", serverDescriptions),
    connectionImportRules(),
    section("Tool Catalog", toolCatalog),
    section("Tool Schemas (exact param names, types, required fields — also read each tool's description for the return shape; some tools return plain strings, XML, or Markdown rather than JSON)", relevantSchemas),
    section("Build-Time Resolved Runtime Targets", buildHints),
    currentCode ? section(`Current Jig Code (${jigId})`, `\`\`\`typescript\n${currentCode}\n\`\`\``) : null,
    exampleJig && jigId !== "weekly-update"
      ? section("Example Jig", `\`\`\`typescript\n${exampleJig}\n\`\`\``)
      : null,
    buildHints
      ? `## Build-Time Resolution Policy
Any runtime target resolved above was discovered during jig creation, not during jig execution.

- Hardcode the resolved IDs, actor names, or resource identifiers directly into the generated jig
- Do NOT emit runtime rediscovery code for those targets
- Do NOT add back excluded search/meta-tools just because they exist on the connection
- Keep the jig focused on the selected runtime tools and concrete execution path`
      : null,
    agentToolProtocol(),
  ])
}

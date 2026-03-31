type CreatorPromptInput = {
  description: string
  probeResults: string
  context: {
    skillMd: string
    typeDefs: string
    toolCatalog: string
    relevantSchemas: string
    exampleJig: string
    serverDescriptions: string
  }
  importPrefix: string
  existingCode?: string
}

type AgentPromptInput = {
  jigId?: string
  entity?: string
  skillMd: string
  typeDefs: string
  toolCatalog: string
  serverDescriptions: string
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

function sharedJigWritingPolicy() {
  return `### 1. Maximize determinism (most important)
Prefer direct tool calls > llm() > agent():
- Direct call when you know the tool + params at write time
- llm() for synthesis, writing, or classification from known data
- agent() only when the sequence of tool calls requires runtime judgment
- Default to breaking large workflows into deterministic steps instead of one giant agent()

### 2. Show progress
Use ctx.output() to show what the jig is doing before each major step.

### 3. Keep params minimal
- Only add params when the user's description implies configurability
- If the request already specifies the value, hardcode it
- If the jig works without user input, omit params entirely
- Do NOT invent placeholder params for values that are already implied by the request

### 4. Use the right tools
The available tools and probe results show what's available. Use multiple relevant tools when they materially improve the result.

### 5. Preserve the existing toolset when editing
- If you are editing an existing jig, do NOT add or remove tools unless the user explicitly asked for tool changes
- Small logic, wording, output, or scheduling edits should usually keep the existing tools unchanged
- Only change the toolset when the current tools are insufficient or invalid for the requested behavior`
}

function creatorOutputRules(importPrefix: string) {
  return `### 5. Code format
- Output ONLY TypeScript code. No explanation, no markdown fences.
- Import SDK from "${importPrefix}/src/index.js" (jig, llm, agent)
- Import connections from "${importPrefix}/.jig/connections/{server}.js"
- Use exact param names and types from the type definitions and schemas above
- Use ctx.output() for output, NEVER console.log()
- End the file with: export default myJig
- Do NOT call run() or process.exit()
- Do NOT use require() or CommonJS imports
- Do NOT add markdown fences around the code`
}

function agentExecutionRules() {
  return `## Agent Workflow
- Act immediately. Do NOT describe a plan first.
- If creating a new jig, choose a short valid jigId first and include it in your first write_jig_file call
- Prefer concise concept names over literal sentence fragments. Good: forgotten-emails, weekly-update, morning-briefing, meeting-prep. Bad: check-my-email-for-emails-i-forgot
- Valid jigId and entity names use only lowercase letters, numbers, dashes, and underscores
- Import SDK from "../src/index.js" (jig, llm, agent) for top-level jigs, "../../src/index.js" for grouped jigs
- Import connections from "../.jig/connections/{server}.js" (or "../../.jig/connections/{server}.js" for grouped jigs)
- Use ctx.output() for output, NEVER console.log()
- End the file with: export default myJig
- Do NOT use require() or CommonJS
- ALWAYS run check_jig after writing code
- If check_jig reports errors, fix them and check again until it passes
- Use web_search and browse to look up API docs when unsure about tool parameters
- When editing an existing jig, preserve the current tools unless the user explicitly asked to add or remove tools, or the current toolset is broken
- When done, reply with 1-2 short plain text sentences summarizing what you changed. No markdown, no code blocks, no bullet points.`
}

export function buildCreatorJigPrompt({
  description,
  probeResults,
  context,
  importPrefix,
  existingCode,
}: CreatorPromptInput): string {
  return joinSections([
    "You are writing a TypeScript jig file that automates workflows.",
    context.typeDefs,
    context.skillMd,
    section("Available Connections", context.serverDescriptions),
    section("Tool Catalog", context.toolCatalog),
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
    `## Rules (in priority order)\n${sharedJigWritingPolicy()}\n\n${creatorOutputRules(importPrefix)}`,
  ])
}

export function buildAgentJigSystemPrompt({
  jigId,
  skillMd,
  typeDefs,
  toolCatalog,
  serverDescriptions,
  currentCode,
  exampleJig,
}: AgentPromptInput): string {
  return joinSections([
    `You are a jig creation and editing agent. You write TypeScript jig files that automate workflows.

IMPORTANT: Act immediately. Do NOT describe what you plan to do — just do it. The jig code is already in your context below, so do NOT call read_jig_file unless you need a different jig. Write the code, check it, and confirm in 1-2 sentences.`,
    skillMd,
    typeDefs,
    section("Available Connections", serverDescriptions),
    section("Tool Catalog", toolCatalog),
    currentCode ? section(`Current Jig Code (${jigId})`, `\`\`\`typescript\n${currentCode}\n\`\`\``) : null,
    exampleJig && jigId !== "weekly-update"
      ? section("Example Jig", `\`\`\`typescript\n${exampleJig}\n\`\`\``)
      : null,
    `## Shared Jig-Writing Policy\n${sharedJigWritingPolicy()}`,
    agentExecutionRules(),
  ])
}

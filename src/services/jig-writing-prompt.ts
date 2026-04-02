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
  existingCode?: string
}

type AgentPromptInput = {
  jigId?: string
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

### 2. Structure with ctx.step() blocks (REQUIRED)
Every jig MUST use block-scoped steps:
\`\`\`typescript
const result = await ctx.step("Human-readable label", [tool1, tool2], async () => {
  // Only tool1 and tool2 are allowed here
  const data = await tool1({...})
  ctx.output("Progress update")
  return data
})
\`\`\`
Rules:
- Wrap every logical group of tool calls in a ctx.step() block
- Each step declares exactly which tools it uses — only those tools work inside the block
- Steps must be sequential (no nesting)
- agent() and llm() calls are always allowed inside any step — they don't need to be in the tools array
- Step labels MUST be static strings — never use template literals with runtime variables. Good: "Research meeting context". Bad: \`Research: \${eventSummary}\`
- ALL ctx.output() calls must be inside ctx.step() blocks — output is tied to the step it belongs to
- Use ctx.output() inside steps to show progress

### 3. Keep params minimal
- Only add params when the user's description implies configurability
- If the request already specifies the value, hardcode it
- If the jig works without user input, omit params entirely
- Do NOT invent placeholder params for values that are already implied by the request

### 4. Hardcode constants, don't discover them at runtime
- If the jig needs a value that is constant across runs (the user's email, name, team, Slack channel, timezone, recipient list, etc.), prefer hardcoding it over discovering it at runtime
- If you don't know a constant, ask the user before writing code. Keep the question short: "What email should I send the briefing to?" Then hardcode their answer.
- Only use params for values that genuinely change between runs

### 5. Use the right tools
The available tools and probe results show what's available. Use multiple relevant tools when they materially improve the result.

### 6. Preserve the existing toolset when editing
- If you are editing an existing jig, do NOT add or remove tools unless the user explicitly asked for tool changes
- Small logic, wording, output, or scheduling edits should usually keep the existing tools unchanged
- Only change the toolset when the current tools are insufficient or invalid for the requested behavior`
}

function codeFormatRules() {
  return `### 7. Code format
- Output ONLY TypeScript code. No explanation, no markdown fences.
- Import SDK: import { jig, llm, agent } from "jig"
- Import connections: import { serverName } from "jig/connections/serverName.js"
- Use exact param names and types from the type definitions and schemas above
- Use ctx.output() inside ctx.step() blocks for output, NEVER console.log()
- ALL tool calls MUST be inside ctx.step() blocks — tools called outside a step will throw at runtime
- End the file with: export default myJig
- Do NOT call run() or process.exit()
- Do NOT use require() or CommonJS imports
- Do NOT use relative imports (../) — always use the "jig" and "jig/connections/" aliases
- Do NOT add markdown fences around the code`
}

function agentExecutionRules() {
  return `## Agent Workflow
- Act immediately. Do NOT describe a plan first.
- If creating a new jig, choose a short valid jigId first and include it in your first write_jig_file call
- Prefer concise concept names over literal sentence fragments. Good: forgotten-emails, weekly-update, morning-briefing, meeting-prep. Bad: check-my-email-for-emails-i-forgot
- Valid jigId names use only lowercase letters, numbers, dashes, and underscores
- Import SDK: import { jig, llm, agent } from "jig"
- Import connections: import { serverName } from "jig/connections/serverName.js"
- Do NOT use relative imports (../) — always use the "jig" and "jig/connections/" aliases
- Use ctx.output() for output, NEVER console.log()
- End the file with: export default myJig
- Do NOT use require() or CommonJS
- BEFORE writing any code, check: does this jig need the user's email, name, Slack channel, or any other personal constant? If yes, STOP and ask the user — do not write code until you have their answer. Do not use a tool call or agent() to discover it at runtime. Do not embed tricks like "find my email in sent mail". Just ask.
- ALWAYS run check_jig after writing code
- If check_jig reports errors, fix them and check again until it passes
- Tool schemas and type definitions are already in your context above — do NOT browse local files or URLs to find them
- Use web_search and browse only for external API docs not already in context
- When editing an existing jig, preserve the current tools unless the user explicitly asked to add or remove tools, or the current toolset is broken
- When done, reply with 1-2 short plain text sentences summarizing what you changed. No markdown, no code blocks, no bullet points.`
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
    `## Rules (in priority order)\n${sharedJigWritingPolicy()}\n\n${codeFormatRules()}`,
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

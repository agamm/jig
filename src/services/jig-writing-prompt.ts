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

function agentExecutionRules() {
  return `## Agent Workflow
- Act immediately. Do NOT describe a plan first.
- If creating a new jig, choose a short valid jigId first and include it in your first write_jig_file call
- Prefer concise concept names over literal sentence fragments. Good: forgotten-emails, weekly-update, morning-briefing, meeting-prep. Bad: check-my-email-for-emails-i-forgot
- Valid jigId names use only lowercase letters, numbers, dashes, and underscores
- Import SDK: import { jig, llm, agent } from "@jig/sdk"
- Import connections: import { serverName } from "@jig/connections/serverName.js"
- Do NOT use relative imports (../) — always use the "@jig/sdk" and "@jig/connections/" aliases
- Use ctx.output() for output, NEVER console.log()
- End the file with: export default myJig
- Do NOT use require() or CommonJS
- BEFORE writing any code, check: does this jig need the user's email, name, Slack channel, or any other personal constant? If yes, STOP and ask the user — do not write code until you have their answer. Do not use a tool call or agent() to discover it at runtime. Do not embed tricks like "find my email in sent mail". Just ask.
- BEFORE writing any code, also check: is the trigger type obvious from the user's description? The three triggers are manual, cron, webhook. If unclear, STOP and ask a short question like "Should this run on a schedule, manually, or via webhook?" Do NOT default to "manual" silently.
- For webhook jigs, the POST body becomes ctx.params as nested JSON. Telegram example: const text = (ctx.params.message as any)?.text. Cast to any for nested shapes.
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
    "## Rules\nFollow the **Jig Writing Rules** section in the skill above. They are enforced by the runner and the static validator.",
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
    agentExecutionRules(),
  ])
}

let _dryRun = process.env.JIG_DRY_RUN === "1"

export function setDryRun(v: boolean) {
  _dryRun = v
  if (v) process.env.JIG_DRY_RUN = "1"
}

export function isDryRun() { return _dryRun }

// Surveyed: GitHub, Slack, Notion, Stripe, Linear, Figma, Filesystem, Azure,
// Sentry, Atlassian MCP servers. Mutation verbs override read verbs.
// Unknown verbs default to mutation (safe).
const READ_VERBS = /^(get|list|search|find|query|read|fetch|retrieve|lookup|describe|check|count|show|view|scan|inspect|browse|validate|verify|preview|estimate|whoami)$/i
const MUTATE_VERBS = /^(create|update|edit|delete|remove|add|set|put|post|push|merge|fork|cancel|send|submit|assign|move|transition|mark|dismiss|manage|finalize|write|upload|publish|insert|modify|patch|duplicate|archive|pin|star|follow|subscribe)$/i

function tokenize(name: string): string[] {
  return name.split(/[-_]/).flatMap((s) => s.split(/(?=[A-Z])/)).map((s) => s.toLowerCase())
}

export function isReadTool(toolName: string): boolean {
  const tokens = tokenize(toolName)
  if (tokens.some((t) => MUTATE_VERBS.test(t))) return false
  return tokens.some((t) => READ_VERBS.test(t))
}

/**
 * Jig Gen — AI-powered jig generation and editing.
 *
 * Abstract module with no CLI coupling. All I/O goes through JigIO.emit()
 * with structured events — the presentation layer decides how to render.
 */
import { join, relative } from "path"
import { existsSync, readFileSync, rmSync } from "fs"
import ts from "typescript"
import { llm, agent } from "./sdk/llm.js"
import { getEditorModel } from "./config/models.js"
import { discoverJigs } from "./discover.js"
import { getServerConfig, loadServerConfigs } from "./mcp/config.js"
import type { JigTool } from "./sdk/jig.js"
import { EXAMPLES_DIR, JIGS_DIR, PROJECT_ROOT, SCHEMAS_DIR } from "./config/paths.js"
import { resolveJigPath } from "./domain/jig-source.js"
import { getImportedServers } from "./domain/source-analysis.js"
import { checkJigFile } from "./services/jig-checker.js"
import { buildCreatorJigPrompt } from "./services/jig-writing-prompt.js"
import { generateTypeDeclaration, toolNameToIdentifier } from "./mcp/typegen.js"
import { renderCodeFacingToolCatalogSection } from "./tool-catalog.js"
import { callTool, connectServer, type McpConnection } from "./mcp/client.js"
import { getConnectorBuildTimeValidator } from "./mcp/validators/index.js"
import type { ConnectEvent } from "../shared/connect-flow.js"
import { logSessionEvent } from "./debug/session-log.js"
const MAX_FIX_ATTEMPTS = 3

// ---------------------------------------------------------------------------
// Public interfaces — structured events, not strings
// ---------------------------------------------------------------------------

export type JigEvent =
  // Creator events
  | { type: "connections"; servers: { name: string; connected: boolean; description: string }[] }
  | { type: "connections-missing"; servers: { name: string; command: string }[] }
  | { type: "connections-unknown"; servers: { name: string }[] }
  | { type: "plan"; servers: string[]; relevantTools: string[]; name: string }
  | { type: "probe-start"; tools: string[] }
  | { type: "probe-done"; summary: string }
  | { type: "generate-start" }
  | { type: "write"; file: string }
  | { type: "validate"; ok: boolean; errors?: string }
  | { type: "fix"; attempt: number; max: number }
  | { type: "dry-run-start" }
  | { type: "dry-run-review"; ok: boolean; issues?: string }
  | { type: "created"; name: string; file: string }
  | { type: "updated"; name: string; file: string }
  | { type: "error"; code: string; message: string; details?: Record<string, any> }
  // Connect events
  | ConnectEvent
  // Run events
  | { type: "jig-list"; jigs: string[] }
  | { type: "run-start"; name: string }

export interface JigIO {
  ask(question: string): Promise<string>
  emit(event: JigEvent): void
}

export interface CreateResult {
  path: string
  name: string
  code: string
}

export function hasExplicitEmptyToolsArray(code: string): boolean {
  const source = ts.createSourceFile("jig.ts", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  let found = false

  const visit = (node: ts.Node) => {
    if (found) return
    if (ts.isPropertyAssignment(node) && isToolsProperty(node.name) && ts.isArrayLiteralExpression(node.initializer)) {
      found = node.initializer.elements.length === 0
      return
    }
    ts.forEachChild(node, visit)
  }

  visit(source)
  return found
}

function isToolsProperty(name: ts.PropertyName): boolean {
  return (ts.isIdentifier(name) || ts.isStringLiteral(name)) && name.text === "tools"
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

export interface AuthoringContext {
  skillMd: string
  typeDefs: string
  toolCatalog: string
  buildHints: string
  relevantSchemas: string
  exampleJig: string
  serverDescriptions: string
}

function extractPromptSkillMd(markdown: string): string {
  const start = markdown.indexOf("## Jig Writing Rules")
  if (start === -1) return markdown.trim()

  const end = markdown.indexOf("\n---\n\n## The Core Principle", start)
  return markdown.slice(start, end === -1 ? undefined : end).trim()
}

export interface BuildTimeResolution {
  server: string
  context: string
  requiredTools?: string[]
  includeTools?: string[]
  excludeTools?: string[]
  resolvedTarget?: string
  resolvedInputSchema?: unknown
}

export interface BuildTimeToolPolicyIssue {
  server: string
  message: string
}

export interface AuthoringState {
  name: string
  servers: string[]
  unknownServers: string[]
  requiresIntegration: boolean
  allServers: string[]
  newServers: string[]
  /** Connections the existing jig imports that aren't currently set up (edit mode). */
  unavailableImports: string[]
  relevantTools: string[]
  buildResolutions: BuildTimeResolution[]
  context: AuthoringContext
}

type AuthoringServerScope = {
  allServers: string[]
  newServers: string[]
  buildResolutionServers: string[]
}

type AssembleContextOptions = {
  includeAllToolsWhenUnscoped?: boolean
}


export async function buildAuthoringState(
  description: string,
  options: {
    existingCode?: string
    ask?: (question: string) => Promise<string>
  } = {}
): Promise<AuthoringState> {
  const serverConfigs = await loadServerConfigs()
  const plan = await planJig(description, serverConfigs)
  const importedServers = options.existingCode ? extractImportedServers(options.existingCode) : []
  const { allServers, newServers, buildResolutionServers } = deriveAuthoringServerScope(importedServers, plan.servers)

  ensureResolvedIntegration(plan.needsIntegration, allServers, plan.unknownServers)
  if (allServers.length > 0 || plan.unknownServers.length > 0) {
    // Connections the jig ALREADY imports are non-blocking: editing a jig
    // shouldn't be refused because a connection it already references is
    // missing — the user is often editing precisely to remove or replace it
    // (e.g. "use composio instead of workspace"). The write-time guard
    // (findDisconnectedImports in toolWriteJigFile) still rejects code that
    // actually uses an unconnected server, so this only relaxes the preflight.
    checkConnections(allServers, plan.unknownServers, serverConfigs, undefined, importedServers)
  }

  const buildResolutions = await resolveBuildTimeTargets(description, buildResolutionServers, serverConfigs, options.ask)
  ensureAuthoringDiscoveryResolved(description, buildResolutionServers, serverConfigs, buildResolutions)
  let relevantTools: string[]
  let includeAllToolsWhenUnscoped = true
  if (options.existingCode) {
    if (newServers.length > 0 || buildResolutions.length > 0) {
      relevantTools = await selectTools(description, allServers, buildResolutions)
    } else {
      relevantTools = extractReferencedToolNames(options.existingCode, allServers)
      includeAllToolsWhenUnscoped = false
    }
  } else {
    relevantTools = await selectTools(description, plan.servers, buildResolutions)
  }
  const context = await assembleContext(allServers, relevantTools, buildResolutions, {
    includeAllToolsWhenUnscoped,
  })

  // Imported connections that aren't set up. The preflight no longer blocks on
  // these (see above), so tell the agent explicitly — otherwise it would try to
  // rewrite around them, hit the write-time guard, and flail. With this it can
  // ask the user to connect them or migrate off them deliberately.
  const unavailableImports = importedServers.filter(
    (server) => !existsSync(join(SCHEMAS_DIR, `${server}.json`))
  )

  return {
    name: plan.name,
    servers: plan.servers,
    unknownServers: plan.unknownServers,
    requiresIntegration: plan.needsIntegration,
    allServers,
    newServers,
    unavailableImports,
    relevantTools,
    buildResolutions,
    context,
  }
}

export function deriveAuthoringServerScope(importedServers: string[], plannedServers: string[]): AuthoringServerScope {
  if (importedServers.length === 0) {
    const servers = [...new Set(plannedServers)]
    return {
      allServers: servers,
      newServers: servers,
      buildResolutionServers: servers,
    }
  }

  const imported = new Set(importedServers)
  const newServers = plannedServers.filter((server) => !imported.has(server))
  return {
    allServers: [...new Set([...importedServers, ...plannedServers])],
    newServers,
    buildResolutionServers: [...new Set([...newServers, ...plannedServers])],
  }
}

export function extractReferencedToolNames(code: string, servers: string[]): string[] {
  const found = new Set<string>()

  for (const serverName of servers) {
    const schemaPath = join(SCHEMAS_DIR, `${serverName}.json`)
    if (!existsSync(schemaPath)) continue

    let schemas: any[]
    try {
      schemas = JSON.parse(readFileSync(schemaPath, "utf-8"))
    } catch {
      continue
    }

    const byIdentifier = new Map<string, string>()
    for (const tool of schemas) {
      if (typeof tool?.name !== "string") continue
      byIdentifier.set(toolNameToIdentifier(tool.name), tool.name)
    }

    const pattern = new RegExp(`\\b${escapeRegExp(serverName)}\\.([A-Za-z_$][\\w$]*)\\b`, "g")
    for (const match of code.matchAll(pattern)) {
      const toolName = byIdentifier.get(match[1])
      if (toolName) found.add(toolName)
    }
  }

  return [...found]
}

// ---------------------------------------------------------------------------
// planJig — identifies servers + filename
// ---------------------------------------------------------------------------

interface JigPlan {
  servers: string[]
  unknownServers: string[]
  name: string
  needsIntegration: boolean
}

function formatServerForAuthoring(
  name: string,
  cfg: any,
  opts: { connected: boolean; connectedToolkits?: string[] }
): string {
  const status = opts.connected ? "connected" : "not connected"
  let description = cfg?.description ?? ""
  if (name === "composio" && opts.connectedToolkits?.length) {
    description += `. Connected toolkits: ${opts.connectedToolkits.join(", ")}`
  }
  const lines = [`- ${name} [${status}]: ${description}`]
  for (const hint of cfg?.meta?.authoringHints ?? []) {
    lines.push(`  Hint: ${hint}`)
  }
  return lines.join("\n")
}

function readConnectedToolkitsFromComposio(): string[] {
  const schemaPath = join(SCHEMAS_DIR, "composio.json")
  if (!existsSync(schemaPath)) return []
  try {
    const tools: Array<{ name?: string }> = JSON.parse(readFileSync(schemaPath, "utf-8"))
    const prefixes = new Set<string>()
    for (const tool of tools) {
      const name = tool?.name
      if (typeof name !== "string") continue
      const prefix = name.split("_")[0]
      if (prefix) prefixes.add(prefix)
    }
    return [...prefixes].sort()
  } catch {
    return []
  }
}

async function planJig(
  description: string,
  serverConfigs: Record<string, any>
): Promise<JigPlan> {
  const entries = Object.entries(serverConfigs)
  const composioToolkits = readConnectedToolkitsFromComposio()
  const serverList = entries
    .map(([name, cfg]) =>
      formatServerForAuthoring(name, cfg, {
        connected: existsSync(join(SCHEMAS_DIR, `${name}.json`)),
        connectedToolkits: name === "composio" ? composioToolkits : undefined,
      })
    )
    .join("\n")

  const result = await llm<{ servers: string[]; unknownServers: string[]; name: string; needsIntegration: boolean }>(
    // Authoring-time planning uses the editor model, not the runtime main model.
    `Plan a workflow automation.

## Available servers (use ONLY these key names)
Each entry is tagged [connected] or [not connected]. "Connected" means credentials are already set up; "not connected" means the user would have to run a connect flow before the jig can run.
${serverList}

## Task
For this workflow: "${description}"

1. "servers": which server keys does this need?
2. "unknownServers": external *services/providers* mentioned that don't match any server above. Do NOT put built-in jig capabilities here.
3. "name": a short kebab-case filename, 2-3 words, descriptive
4. "needsIntegration": true if the workflow clearly depends on an external service, MCP server, or provider integration; false only if it can be done with pure logic and no external service

Important:
- \`ctx.email\` is a BUILT-IN jig capability (it emails the user a repliable message — reply-to-edit — with NO connection or server). Never treat "ctx email", "ctx.email", or "reply-to-edit email" as a server or an unknownServer. Likewise \`llm()\`, \`agent()\`, \`ctx.step\`, \`ctx.output\`, \`ctx.parallel\` are built in and need no server. An instruction like "replace gmail send with ctx email" REMOVES a server dependency — it does not add one.
- Prefer the smallest sufficient server set
- Strongly prefer servers tagged [connected]. If a [connected] server can cover the task (including via composio's listed connected toolkits), pick it instead of a [not connected] alternative — do not pick a [not connected] server when a [connected] one suffices
- Only pick a [not connected] server when no [connected] server can do the task
- If the user explicitly names one of the available servers or clearly references that provider/connection, include that exact server in "servers"
- If the user says to do something via/using/through a specific server, prefer that server and do not add another server just because the target website or data source matches its brand
- Only include an additional server when the workflow truly needs that server's own authenticated API, write actions, or first-party tools beyond what the explicit provider can already do
- Server descriptions are capabilities, not keyword substitution rules. Do not infer a server solely from a product word when the user explicitly chose another available server.
- Do not replace an explicitly named server with a different inferred alternative unless the named one is clearly impossible for the task`,
    {},
    { schema: { servers: "array", unknownServers: "array", name: "string", needsIntegration: "boolean" } as any, model: getEditorModel() }
  )

  const validServers = (result.servers || []).filter(s => s in serverConfigs)
  const invalidServers = (result.servers || []).filter(s => !(s in serverConfigs))

  // Guard: built-in jig capabilities (ctx.email, llm, agent, ctx.*) are not
  // servers — never let the planner block authoring by flagging one as unknown.
  const isBuiltin = (s: string) => /\bctx\b|ctx[.\s]?email|reply.?to.?edit|^(llm|agent)$/i.test(s.trim())

  return {
    servers: validServers,
    unknownServers: [...(result.unknownServers || []), ...invalidServers].filter(s => !isBuiltin(s)),
    name: (result.name || "new-jig")
      .toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "") || "new-jig",
    needsIntegration: result.needsIntegration === true,
  }
}

function ensureResolvedIntegration(
  needsIntegration: boolean,
  resolvedServers: string[],
  unknownServers: string[],
  emit?: (event: JigEvent) => void
): void {
  if (!needsIntegration || resolvedServers.length > 0) return
  if (unknownServers.length > 0) {
    emit?.({ type: "connections-unknown", servers: unknownServers.map((name) => ({ name })) })
  }
  emit?.({
    type: "error",
    code: "integration-unresolved",
    message: "Workflow depends on an integration but no known server was resolved",
    details: { unknownServers },
  })
  throw new CreatorError("integration-unresolved", "Workflow depends on an integration but no known server was resolved")
}

// ---------------------------------------------------------------------------
// selectTools — dedicated LLM call to pick relevant tools from full list
// ---------------------------------------------------------------------------

async function selectTools(
  description: string,
  servers: string[],
  buildResolutions: BuildTimeResolution[] = []
): Promise<string[]> {
  let toolList = ""
  const availableToolNames: string[] = []
  const resolutionsByServer = new Map(buildResolutions.map((resolution) => [resolution.server, resolution]))
  for (const serverName of servers) {
    const schemaPath = join(SCHEMAS_DIR, `${serverName}.json`)
    if (!existsSync(schemaPath)) continue
    const schemas: any[] = JSON.parse(readFileSync(schemaPath, "utf-8"))
    const resolution = resolutionsByServer.get(serverName)
    const includeSet = resolution?.includeTools?.length ? new Set(resolution.includeTools) : null
    const excludeSet = new Set(resolution?.excludeTools ?? [])
    const runtimeSchemas = schemas.filter((tool) => {
      if (excludeSet.has(tool.name)) return false
      if (includeSet) return includeSet.has(tool.name)
      return true
    })
    toolList += `\n## ${serverName}\n`
    for (const t of runtimeSchemas) {
      if (typeof t.name !== "string") continue
      availableToolNames.push(t.name)
      // First-line-only: the selector only needs enough to know what the tool
      // is for, not its full usage docs. Cuts the prompt ~3-5x on servers
      // with verbose MCP descriptions (Gmail, Drive, Calendar).
      const firstLine = (t.description ?? "").split("\n")[0].trim()
      toolList += `  ${t.name}: ${firstLine}\n`
    }
  }

  const buildHints = buildResolutions
    .map((resolution) => {
      const parts = [`## ${resolution.server}`]
      if (resolution.context) parts.push(resolution.context)
      if (resolution.requiredTools?.length) parts.push(`Must use these runtime tools: ${resolution.requiredTools.join(", ")}`)
      if (resolution.includeTools?.length) parts.push(`Prefer these runtime tools: ${resolution.includeTools.join(", ")}`)
      if (resolution.excludeTools?.length) parts.push(`Avoid these runtime tools unless the user explicitly wants dynamic rediscovery: ${resolution.excludeTools.join(", ")}`)
      return parts.join("\n")
    })
    .join("\n\n")

  const result = await llm<{ tools: string[] }>(
    `Select which tools a workflow automation would need.

## Available tools
${toolList}

${buildHints ? `## Build-time resolved runtime targets
${buildHints}

When build-time discovery already chose a concrete runtime target, prefer the concrete runtime tools it recommends. Do not keep search/discovery meta-tools unless the jig truly needs to rediscover at runtime.
` : ""}

## Workflow
${description}

Start by including ALL tools from the relevant servers. Then remove only tools that are clearly irrelevant to this workflow. When in doubt, keep the tool — it's much better to include an extra tool than to miss one the workflow needs.

Return "tools": an array of tool name strings.`,
    {},
    { schema: { tools: "array" } as any, model: getEditorModel() }
  )

  const excludedTools = buildResolutions.flatMap((resolution) => resolution.excludeTools ?? [])
  const selected = new Set(normalizeSelectedToolNames(result.tools || [], availableToolNames, excludedTools))
  for (const resolution of buildResolutions) {
    for (const tool of resolution.includeTools ?? []) {
      if (availableToolNames.includes(tool) && !excludedTools.includes(tool)) selected.add(tool)
    }
    for (const tool of resolution.excludeTools ?? []) selected.delete(tool)
  }
  return [...selected]
}

export function normalizeSelectedToolNames(
  selectedToolNames: unknown[],
  availableToolNames: string[],
  excludedToolNames: string[] = []
): string[] {
  const excluded = new Set(excludedToolNames)
  const byAcceptedName = new Map<string, string>()
  for (const toolName of availableToolNames) {
    byAcceptedName.set(toolName, toolName)
    byAcceptedName.set(toolNameToIdentifier(toolName), toolName)
  }

  const selected = new Set<string>()
  for (const rawName of selectedToolNames) {
    if (typeof rawName !== "string") continue
    const toolName = byAcceptedName.get(rawName)
    if (toolName && !excluded.has(toolName)) selected.add(toolName)
  }

  if (selected.size === 0) {
    for (const toolName of availableToolNames) {
      if (!excluded.has(toolName)) selected.add(toolName)
    }
  }

  return [...selected]
}

// ---------------------------------------------------------------------------
// checkConnections — emits structured events, throws on missing
// ---------------------------------------------------------------------------

function checkConnections(
  knownServers: string[],
  unknownServers: string[],
  serverConfigs: Record<string, any>,
  emit?: (event: JigEvent) => void,
  /** Servers that may be missing without blocking (already imported by the jig being edited). */
  nonBlocking: string[] = []
): void {
  const servers = knownServers.map(s => ({
    name: s,
    connected: existsSync(join(SCHEMAS_DIR, `${s}.json`)),
    description: (serverConfigs[s] as any)?.description ?? "",
  }))

  emit?.({ type: "connections", servers })

  const missing = servers.filter(s => !s.connected)
  if (missing.length > 0) {
    emit?.({
      type: "connections-missing",
      servers: missing.map(s => ({ name: s.name, command: `jig connect ${s.name}` })),
    })
  }

  if (unknownServers.length > 0) {
    emit?.({ type: "connections-unknown", servers: unknownServers.map(name => ({ name })) })
  }

  // Only a NEW required connection (or an unknown server) blocks authoring;
  // already-imported missing connections are surfaced above but don't throw.
  const blockingMissing = missing.filter(s => !nonBlocking.includes(s.name))
  if (blockingMissing.length > 0 || unknownServers.length > 0) {
    throw new CreatorError("missing-connections", "Required connections are not set up", {
      suggestedConnections: servers.map((server) => server.name),
      requiredConnections: blockingMissing.map((server) => server.name),
      connectionStatuses: servers.map(({ name, connected }) => ({ name, connected })),
      unknownConnections: unknownServers,
    })
  }
}

export class CreatorError extends Error {
  constructor(
    public code: string,
    message: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// loadReadOnlyTools
// ---------------------------------------------------------------------------

const CONNECTIONS_DIR = join(PROJECT_ROOT, ".jig/connections")

async function loadReadOnlyTools(servers: string[], relevantTools?: string[]): Promise<JigTool<any, any>[]> {
  const tools: JigTool<any, any>[] = []
  const toolSet = relevantTools?.length ? new Set(relevantTools) : null

  for (const serverName of servers) {
    // Import the generated connection module — it has the tool functions with metadata
    const modPath = join(CONNECTIONS_DIR, `${serverName}.ts`)
    if (!existsSync(modPath)) continue
    const mod = await import(modPath)

    // Filter to read-only + relevant tools using schema annotations
    const schemaPath = join(SCHEMAS_DIR, `${serverName}.json`)
    if (!existsSync(schemaPath)) continue
    const schemas: any[] = JSON.parse(readFileSync(schemaPath, "utf-8"))

    for (const t of schemas) {
      if (!t.annotations?.readOnlyHint) continue
      if (toolSet && !toolSet.has(t.name)) continue
      const exported = mod[toolNameToIdentifier(t.name)] ?? mod[serverName]?.[t.name]
      if (exported) tools.push(exported)
    }
  }

  return tools
}

// ---------------------------------------------------------------------------
// assembleContext
// ---------------------------------------------------------------------------

async function assembleContext(
  servers: string[],
  relevantToolNames?: string[],
  buildResolutions: BuildTimeResolution[] = [],
  options: AssembleContextOptions = {}
): Promise<AuthoringContext> {
  const skillPath = join(PROJECT_ROOT, "SKILL.md")
  const rawSkillMd = existsSync(skillPath) ? await Bun.file(skillPath).text() : ""
  const skillMd = extractPromptSkillMd(rawSkillMd)

  let toolCatalog = ""
  let relevantSchemas = ""
  const toolSet = relevantToolNames?.length ? new Set(relevantToolNames) : null
  const includeAllToolsWhenUnscoped = options.includeAllToolsWhenUnscoped ?? true
  const typeDefSections: string[] = []
  for (const serverName of servers) {
    const schemaPath = join(SCHEMAS_DIR, `${serverName}.json`)
    if (!existsSync(schemaPath)) continue
    const allSchemas: any[] = JSON.parse(readFileSync(schemaPath, "utf-8"))
    const scoped = toolSet
      ? allSchemas.filter((tool) => toolSet.has(tool.name))
      : includeAllToolsWhenUnscoped ? allSchemas : []

    if (scoped.length > 0) {
      typeDefSections.push(`// --- ${serverName}.d.ts ---\n${generateTypeDeclaration(serverName, scoped as any)}`)
    }

    // Catalog: only relevant runtime tools so generation stays focused on the selected API surface.
    if (scoped.length > 0) {
      toolCatalog += `\n${renderCodeFacingToolCatalogSection(serverName, scoped)}\n`
    }
    // Schemas: only relevant tools (so the LLM gets exact params without noise)
    if (scoped.length > 0) {
      relevantSchemas += `\n## ${serverName} tool schemas\n${JSON.stringify(scoped)}\n`
    }
  }
  const typeDefs = typeDefSections.join("\n\n")

  const examplePath = join(EXAMPLES_DIR, "weekly-update.ts")
  const exampleJig = existsSync(examplePath) ? await Bun.file(examplePath).text() : ""

  const configs = await loadServerConfigs()
  const composioToolkits = servers.includes("composio") ? readConnectedToolkitsFromComposio() : []
  const serverDescriptions = servers
    .map((serverName) => {
      const cfg = (configs as any)[serverName]
      const lines = [`- ${serverName}: ${cfg?.description ?? ""}`]
      // composio is a proxy: the agent must know WHICH integrations are actually
      // connected through it (and that they're reached as composio.<toolkit>_*),
      // not just that "250+" exist. Without this it can't tell that e.g. Gmail
      // is available here rather than via a dedicated connection.
      if (serverName === "composio" && composioToolkits.length > 0) {
        lines.push(`  Connected integrations (call their tools as composio.<name>_*): ${composioToolkits.join(", ")}`)
      }
      for (const hint of cfg?.meta?.authoringHints ?? []) {
        lines.push(`  Hint: ${hint}`)
      }
      if (cfg?.meta?.provider) lines.push(`  Provider: ${cfg.meta.provider}`)
      if (cfg?.meta?.docs) lines.push(`  Docs: ${cfg.meta.docs}`)
      return lines.join("\n")
    })
    .join("\n")

  const buildHints = buildResolutions
    .map((resolution) => `## ${resolution.server}\n${resolution.context}`)
    .join("\n\n")

  return { skillMd, typeDefs, toolCatalog, buildHints, relevantSchemas, exampleJig, serverDescriptions }
}

type BuildDiscoverModule = {
  resolveForBuild?: (args: {
    description: string
    connection: McpConnection
    ask?: (question: string) => Promise<string>
  }) => Promise<{ context: string; requiredTools?: string[]; includeTools?: string[]; excludeTools?: string[]; resolvedTarget?: string; resolvedInputSchema?: unknown } | null>
  resolveForBuildWithOps?: (
    args: {
      description: string
      connection: McpConnection
      ask?: (question: string) => Promise<string>
    },
    ops: {
      callTool: typeof callTool
      llm: typeof llm
    }
  ) => Promise<{ context: string; requiredTools?: string[]; includeTools?: string[]; excludeTools?: string[]; resolvedTarget?: string; resolvedInputSchema?: unknown } | null>
}

function summarizeForLog(value: unknown, maxLength = 600): unknown {
  if (typeof value === "string") {
    return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value
  }
  if (Array.isArray(value)) {
    return value.slice(0, 10).map((item) => summarizeForLog(item, Math.floor(maxLength / 4)))
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).slice(0, 12)
    return Object.fromEntries(entries.map(([key, nested]) => [key, summarizeForLog(nested, Math.floor(maxLength / 2))]))
  }
  return value
}

function getMissingAuthoringDiscoveryServers(
  servers: string[],
  serverConfigs: Record<string, any>,
  buildResolutions: BuildTimeResolution[]
): string[] {
  const resolvedServers = new Set(buildResolutions.map((resolution) => resolution.server))
  return servers.filter((serverName) => Boolean(serverConfigs[serverName]?.authoringDiscovery) && !resolvedServers.has(serverName))
}

function ensureAuthoringDiscoveryResolved(
  description: string,
  servers: string[],
  serverConfigs: Record<string, any>,
  buildResolutions: BuildTimeResolution[]
): void {
  const missing = getMissingAuthoringDiscoveryServers(servers, serverConfigs, buildResolutions)
  if (missing.length === 0) return

  throw new CreatorError(
    "authoring-discovery-unresolved",
    `Authoring-time discovery could not resolve a concrete runtime target for: ${missing.join(", ")}. Add more detail about the exact site, dataset, or task before writing the jig.`,
    {
      description,
      servers: missing,
    }
  )
}

async function resolveBuildTimeTargets(
  description: string,
  servers: string[],
  serverConfigs: Record<string, any>,
  ask?: (question: string) => Promise<string>
): Promise<BuildTimeResolution[]> {
  const results: BuildTimeResolution[] = []
  if (servers.length > 0) {
    logSessionEvent({
      source: "authoring.discovery",
      event: "start",
      description,
      servers,
    })
  }

  for (const serverName of servers) {
    const discoverPath = serverConfigs[serverName]?.authoringDiscovery
    if (!discoverPath) continue

    const config = await getServerConfig(serverName)
    const connection = await connectServer(serverName, config)

    try {
      const mod = await import(join(PROJECT_ROOT, discoverPath)) as BuildDiscoverModule
      logSessionEvent({
        source: "authoring.discovery",
        event: "server-start",
        server: serverName,
        discoverPath,
        description,
      })

      if (typeof mod.resolveForBuild !== "function" && typeof mod.resolveForBuildWithOps !== "function") continue

      const wrappedOps = {
        callTool: async (wrappedConnection: McpConnection, toolName: string, args: any) => {
          logSessionEvent({
            source: "authoring.discovery",
            event: "tool-call",
            server: serverName,
            tool: toolName,
            args: summarizeForLog(args),
          })
          try {
            const result = await callTool(wrappedConnection, toolName, args)
            logSessionEvent({
              source: "authoring.discovery",
              event: "tool-result",
              server: serverName,
              tool: toolName,
              result: summarizeForLog(result),
            })
            return result
          } catch (error) {
            logSessionEvent({
              source: "authoring.discovery",
              event: "tool-error",
              server: serverName,
              tool: toolName,
              args: summarizeForLog(args),
              error,
            })
            throw error
          }
        },
        llm: async <T>(prompt: string, data: Record<string, unknown>, options?: any): Promise<T> => {
          logSessionEvent({
            source: "authoring.discovery",
            event: "llm-request",
            server: serverName,
            prompt: summarizeForLog(prompt),
            data: summarizeForLog(data),
            options: summarizeForLog(options),
          })
          try {
            const result = await llm<T>(prompt, data, options)
            logSessionEvent({
              source: "authoring.discovery",
              event: "llm-response",
              server: serverName,
              result: summarizeForLog(result),
            })
            return result
          } catch (error) {
            logSessionEvent({
              source: "authoring.discovery",
              event: "llm-error",
              server: serverName,
              prompt: summarizeForLog(prompt),
              error,
            })
            throw error
          }
        },
      }

      const discoveryArgs = {
        description,
        connection,
        ask,
      }

      const resolved = typeof mod.resolveForBuildWithOps === "function"
        ? await mod.resolveForBuildWithOps(discoveryArgs, wrappedOps)
        : await mod.resolveForBuild?.(discoveryArgs)

      if (resolved) {
        results.push({
          server: serverName,
          context: resolved.context,
          requiredTools: resolved.requiredTools,
          includeTools: resolved.includeTools,
          excludeTools: resolved.excludeTools,
          resolvedTarget: resolved.resolvedTarget,
          resolvedInputSchema: resolved.resolvedInputSchema,
        })
      }
      logSessionEvent({
        source: "authoring.discovery",
        event: "server-done",
        server: serverName,
        resolved: Boolean(resolved),
        resolution: resolved
          ? {
              requiredTools: resolved.requiredTools,
              includeTools: resolved.includeTools,
              excludeTools: resolved.excludeTools,
              resolvedTarget: resolved.resolvedTarget,
              resolvedInputSchema: summarizeForLog(resolved.resolvedInputSchema),
              context: summarizeForLog(resolved.context),
            }
          : null,
      })
    } catch (error) {
      logSessionEvent({
        source: "authoring.discovery",
        event: "server-error",
        server: serverName,
        discoverPath,
        error,
      })
      throw error
    } finally {
      await connection.transport.close().catch(() => {})
      await connection.client.close().catch(() => {})
    }
  }

  if (servers.length > 0) {
    logSessionEvent({
      source: "authoring.discovery",
      event: "done",
      description,
      servers,
      resolvedServers: results.map((result) => result.server),
    })
  }

  return results
}

export function collectBuildTimeToolPolicyIssues(
  code: string,
  buildResolutions: BuildTimeResolution[]
): BuildTimeToolPolicyIssue[] {
  const issues: BuildTimeToolPolicyIssue[] = []

  for (const resolution of buildResolutions) {
    const required = resolution.requiredTools ?? []
    const included = resolution.includeTools ?? []
    const excluded = resolution.excludeTools ?? []

    if (required.length > 0 && !required.every((toolName) => codeUsesConnectionTool(code, resolution.server, toolName))) {
      issues.push({
        server: resolution.server,
        message: `Build-time discovery already resolved the runtime target. This code must use the required runtime tools for ${resolution.server}: ${required.join(", ")}.`,
      })
    } else if (included.length > 0 && !included.some((toolName) => codeUsesConnectionTool(code, resolution.server, toolName))) {
      issues.push({
        server: resolution.server,
        message: `Build-time discovery already resolved the runtime target. Use one of the allowed runtime tools for ${resolution.server}: ${included.join(", ")}.`,
      })
    }

    for (const toolName of excluded) {
      if (!codeUsesConnectionTool(code, resolution.server, toolName)) continue
      issues.push({
        server: resolution.server,
        message: `Do not use ${resolution.server}.${toolNameToIdentifier(toolName)} at runtime here. Build-time discovery already resolved the target, so keep runtime code on concrete execution tools only.`,
      })
    }

    const connectorValidator = getConnectorBuildTimeValidator(resolution.server)
    for (const issue of connectorValidator?.({ code, resolution }) ?? []) {
      issues.push({
        server: resolution.server,
        message: issue.message,
      })
    }
  }

  return issues
}

function codeUsesConnectionTool(code: string, serverName: string, toolName: string): boolean {
  const identifier = toolNameToIdentifier(toolName)
  const escapedServer = escapeRegExp(serverName)
  const escapedIdentifier = escapeRegExp(identifier)
  const escapedToolName = escapeRegExp(toolName)
  return (
    new RegExp(`\\b${escapedServer}\\.${escapedIdentifier}\\b`).test(code)
    || new RegExp(`\\b${escapedServer}\\[(["'])${escapedToolName}\\1\\]`).test(code)
  )
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function stripCodeFences(code: string): string {
  return code
    .replace(/^```(?:typescript|ts)?\s*\n/m, "")
    .replace(/\n```\s*$/m, "")
    .trim()
}

export function extractImportedServers(code: string): string[] {
  return getImportedServers(code)
}

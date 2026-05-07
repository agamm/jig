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
import { discoverJigs } from "./discover.js"
import { getServerConfig, loadServerConfigs } from "./mcp/config.js"
import type { JigTool } from "./sdk/jig.js"
import { EXAMPLES_DIR, JIGS_DIR, PROJECT_ROOT, SCHEMAS_DIR } from "./config/paths.js"
import { resolveJigPath } from "./domain/jig-source.js"
import { getImportedServers } from "./domain/source-analysis.js"
import { checkJigFile } from "./services/jig-checker.js"
import { writeJigSource } from "./services/jig-writer.js"
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
  relevantTools: string[]
  buildResolutions: BuildTimeResolution[]
  context: AuthoringContext
}

type AuthoringServerScope = {
  allServers: string[]
  newServers: string[]
  buildResolutionServers: string[]
}

// ---------------------------------------------------------------------------
// createJig
// ---------------------------------------------------------------------------

export async function createJig(description: string, io: JigIO): Promise<CreateResult> {
  // 1. Plan: identify servers + filename
  const serverConfigs = await loadServerConfigs()
  const plan = await planJig(description, serverConfigs)
  ensureResolvedIntegration(plan.needsIntegration, plan.servers, plan.unknownServers, io.emit)

  // 2. Check connections
  checkConnections(plan.servers, plan.unknownServers, serverConfigs, io.emit)

  // 3. Resolve dynamic sub-tools at build time, then select relevant runtime tools
  const buildResolutions = await resolveBuildTimeTargets(description, plan.servers, serverConfigs, io.ask)
  ensureAuthoringDiscoveryResolved(description, plan.servers, serverConfigs, buildResolutions)
  const relevantTools = await selectTools(description, plan.servers, buildResolutions)
  io.emit({ type: "plan", servers: plan.servers, relevantTools, name: plan.name })

  // 4. Check filename
  const name = plan.name
  const targetPath = join(JIGS_DIR, `${name}.ts`)
  if (existsSync(targetPath)) {
    io.emit({ type: "error", code: "file-exists", message: `jigs/${name}.ts already exists`, details: { name, suggestion: `jig edit ${name}` } })
    throw new CreatorError("file-exists", `jigs/${name}.ts already exists`)
  }

  // 5. Assemble context
  const context = await assembleContext(plan.servers, relevantTools, buildResolutions)

  // 6. Probe — scoped to relevant tools only
  const readTools = await loadReadOnlyTools(plan.servers, relevantTools)
  io.emit({ type: "probe-start", tools: readTools.map(t => `${t._serverName}.${t._toolName}`) })
  const probeResults = await probe(description, readTools, renderProbeToolCatalog(readTools))
  io.emit({ type: "probe-done", summary: probeResults })

  // 7. Generate
  io.emit({ type: "generate-start" })
  let code = await generateJigCode(description, probeResults, context)
  code = stripCodeFences(code)

  // 8. Write + validate + fix loop
  const relFile = `jigs/${name}.ts`
  io.emit({ type: "write", file: relFile })
  await writeJigSource(targetPath, code, { jigId: name })
  try {
    code = await validateAndFix(targetPath, code, context, io, {
      requiresIntegration: plan.needsIntegration,
      buildResolutions,
    })
  } catch (error) {
    rmSync(targetPath, { force: true })
    throw error
  }

  // 9. Dry-run + LLM review
  code = await dryRunAndReview(description, code, context, name, io)
  // Final write ensures file matches returned code even if dryRunAndReview
  // found no issues (validateAndFix already wrote, but code may differ after dry-run fix)

  // Ensure trigger is present (default to manual if LLM omitted it)
  if (!/trigger\s*:/.test(code)) {
    code = code.replace(
      /jig\(\s*["'][^"']+["']\s*,\s*\{/,
      (match) => `${match}\n    trigger: { type: "manual" },`
    )
  }

  await writeJigSource(targetPath, code, { jigId: name })

  io.emit({ type: "created", name, file: relFile })
  return { path: targetPath, name, code }
}

// ---------------------------------------------------------------------------
// editJig
// ---------------------------------------------------------------------------

export async function editJig(
  name: string,
  instruction: string,
  io: JigIO
): Promise<CreateResult> {
  const jigs = discoverJigs(JIGS_DIR)
  if (!jigs.has(name)) {
    io.emit({ type: "error", code: "jig-not-found", message: `Jig not found: ${name}` })
    throw new CreatorError("jig-not-found", `Jig not found: ${name}`)
  }

  const targetPath = resolveJigPath(name)

  const existingCode = await Bun.file(targetPath).text()

  // Check if instruction needs new servers
  const serverConfigs = await loadServerConfigs()
  const plan = await planJig(instruction, serverConfigs)
  const importedServers = extractImportedServers(existingCode)
  ensureResolvedIntegration(plan.needsIntegration, [...importedServers, ...plan.servers], plan.unknownServers, io.emit)
  const { allServers, newServers, buildResolutionServers } = deriveAuthoringServerScope(importedServers, plan.servers)

  if (allServers.length > 0 || plan.unknownServers.length > 0) {
    checkConnections(allServers, plan.unknownServers, serverConfigs, io.emit)
  }

  const buildResolutions = await resolveBuildTimeTargets(instruction, buildResolutionServers, serverConfigs, io.ask)
  ensureAuthoringDiscoveryResolved(instruction, buildResolutionServers, serverConfigs, buildResolutions)
  const relevantTools = newServers.length > 0 || buildResolutions.length > 0
    ? await selectTools(instruction, allServers, buildResolutions)
    : []
  const context = await assembleContext(allServers, relevantTools, buildResolutions)

  // Probe only for new servers, scoped to relevant tools
  let probeResults = ""
  if (newServers.length > 0) {
    const readTools = await loadReadOnlyTools(newServers, relevantTools)
    io.emit({ type: "probe-start", tools: readTools.map(t => `${t._serverName}.${t._toolName}`) })
    probeResults = await probe(instruction, readTools, renderProbeToolCatalog(readTools))
    io.emit({ type: "probe-done", summary: probeResults })
  }

  io.emit({ type: "generate-start" })
  let code = await generateJigCode(instruction, probeResults, context, {
    edit: { existingCode },
  })
  code = stripCodeFences(code)

  await writeJigSource(targetPath, code, { jigId: name })
  try {
    code = await validateAndFix(targetPath, code, context, io, {
      requiresIntegration: plan.needsIntegration || importedServers.length > 0,
      buildResolutions,
    })
  } catch (error) {
    await writeJigSource(targetPath, existingCode, { jigId: name })
    throw error
  }
  code = await dryRunAndReview(instruction, code, context, name, io)

  // Ensure trigger is present (default to manual if LLM omitted it)
  if (!/trigger\s*:/.test(code)) {
    code = code.replace(
      /jig\(\s*["'][^"']+["']\s*,\s*\{/,
      (match) => `${match}\n    trigger: { type: "manual" },`
    )
  }

  await writeJigSource(targetPath, code, { jigId: name })

  const relFile = relative(PROJECT_ROOT, targetPath)
  io.emit({ type: "updated", name, file: relFile })
  return { path: targetPath, name, code }
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

  const buildResolutions = await resolveBuildTimeTargets(description, buildResolutionServers, serverConfigs, options.ask)
  ensureAuthoringDiscoveryResolved(description, buildResolutionServers, serverConfigs, buildResolutions)
  const relevantTools = options.existingCode
    ? (newServers.length > 0 || buildResolutions.length > 0
        ? await selectTools(description, allServers, buildResolutions)
        : [])
    : await selectTools(description, plan.servers, buildResolutions)
  const context = await assembleContext(allServers, relevantTools, buildResolutions)

  return {
    name: plan.name,
    servers: plan.servers,
    unknownServers: plan.unknownServers,
    requiresIntegration: plan.needsIntegration,
    allServers,
    newServers,
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

  const keywordHints = entries
    .map(([name, cfg]) => {
      const desc = (cfg as any).description ?? ""
      const keywords = desc.split(/[,&]+/).map((s: string) => s.trim()).filter(Boolean)
      return keywords.length > 1
        ? `If the user mentions ${keywords.join(", or ")}, the server key is "${name}".`
        : ""
    })
    .filter(Boolean)
    .join("\n")

  const result = await llm<{ servers: string[]; unknownServers: string[]; name: string; needsIntegration: boolean }>(
    `Plan a workflow automation.

## Available servers (use ONLY these key names)
Each entry is tagged [connected] or [not connected]. "Connected" means credentials are already set up; "not connected" means the user would have to run a connect flow before the jig can run.
${serverList}

${keywordHints}

## Task
For this workflow: "${description}"

1. "servers": which server keys does this need?
2. "unknownServers": services mentioned that don't match any server above
3. "name": a short kebab-case filename, 2-3 words, descriptive
4. "needsIntegration": true if the workflow clearly depends on an external service, MCP server, or provider integration; false only if it can be done with pure logic and no external service

Important:
- Prefer the smallest sufficient server set
- Strongly prefer servers tagged [connected]. If a [connected] server can cover the task (including via composio's listed connected toolkits), pick it instead of a [not connected] alternative — do not pick a [not connected] server when a [connected] one suffices
- Only pick a [not connected] server when no [connected] server can do the task
- If the user explicitly names one of the available servers or clearly references that provider/connection, include that exact server in "servers"
- If the user says to do something via/using/through a specific server, prefer that server and do not add another server just because the target website or data source matches its brand
- Only include an additional server when the workflow truly needs that server's own authenticated API, write actions, or first-party tools beyond what the explicit provider can already do
- Do not replace an explicitly named server with a different inferred alternative unless the named one is clearly impossible for the task`,
    {},
    { schema: { servers: "array", unknownServers: "array", name: "string", needsIntegration: "boolean" } as any }
  )

  const validServers = (result.servers || []).filter(s => s in serverConfigs)
  const invalidServers = (result.servers || []).filter(s => !(s in serverConfigs))

  return {
    servers: validServers,
    unknownServers: [...(result.unknownServers || []), ...invalidServers],
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
      toolList += `  ${t.name}: ${t.description ?? ""}\n`
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
    { schema: { tools: "array" } as any }
  )

  const selected = new Set(result.tools || [])
  for (const resolution of buildResolutions) {
    for (const tool of resolution.includeTools ?? []) selected.add(tool)
    for (const tool of resolution.excludeTools ?? []) selected.delete(tool)
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
  emit?: (event: JigEvent) => void
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

  if (missing.length > 0 || unknownServers.length > 0) {
    throw new CreatorError("missing-connections", "Required connections are not set up", {
      suggestedConnections: servers.map((server) => server.name),
      requiredConnections: missing.map((server) => server.name),
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
  buildResolutions: BuildTimeResolution[] = []
): Promise<AuthoringContext> {
  const skillPath = join(PROJECT_ROOT, "SKILL.md")
  const rawSkillMd = existsSync(skillPath) ? await Bun.file(skillPath).text() : ""
  const skillMd = extractPromptSkillMd(rawSkillMd)

  let toolCatalog = ""
  let relevantSchemas = ""
  const toolSet = relevantToolNames?.length ? new Set(relevantToolNames) : null
  const typeDefSections: string[] = []
  for (const serverName of servers) {
    const schemaPath = join(SCHEMAS_DIR, `${serverName}.json`)
    if (!existsSync(schemaPath)) continue
    const allSchemas: any[] = JSON.parse(readFileSync(schemaPath, "utf-8"))
    const scoped = toolSet
      ? allSchemas.filter((tool) => toolSet.has(tool.name))
      : allSchemas

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
  const serverDescriptions = servers
    .map((serverName) => {
      const cfg = (configs as any)[serverName]
      const lines = [`- ${serverName}: ${cfg?.description ?? ""}`]
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

// ---------------------------------------------------------------------------
// probe
// ---------------------------------------------------------------------------

async function probe(
  description: string,
  readTools: JigTool<any, any>[],
  toolCatalog: string
): Promise<string> {
  if (readTools.length === 0) return "(no read tools available for probing)"

  return agent<string>(
    `You are exploring a user's connected services to understand what data is available
for building an automation.

The user wants: "${description}"

Available tools (read-only):
${toolCatalog}

Your job:
1. Identify which tools are relevant to this automation
2. Call a few read-only tools to test connectivity and understand output shapes
3. Note field names, data formats, enum values, and what data is available
4. Keep it focused — 3-6 tool calls max

Report your findings as structured notes. Do NOT write any code.`,
    readTools
  )
}

function renderProbeToolCatalog(readTools: JigTool<any, any>[]): string {
  if (readTools.length === 0) return ""
  return readTools
    .map((tool) => `- ${tool._serverName}.${toolNameToIdentifier(tool._toolName)} (MCP tool: "${tool._toolName}")`)
    .join("\n")
}

// ---------------------------------------------------------------------------
// generateJigCode
// ---------------------------------------------------------------------------

async function generateJigCode(
  description: string,
  probeResults: string,
  context: AuthoringContext,
  options?: { edit?: { existingCode: string } }
): Promise<string> {
  const prompt = buildCreatorJigPrompt({
    description,
    probeResults,
    context,
    existingCode: options?.edit?.existingCode,
  })

  const result = await llm(prompt, {}, { maxTokens: 16384 })
  return result as string
}

// ---------------------------------------------------------------------------
// validate (programmatic tsc, filtered to target file)
// ---------------------------------------------------------------------------

async function validate(filePath: string): Promise<{ ok: boolean; errors?: string }> {
  const result = await checkJigFile(filePath)
  return result === "ok" ? { ok: true } : { ok: false, errors: result }
}

// ---------------------------------------------------------------------------
// fixCode
// ---------------------------------------------------------------------------

async function fixCode(code: string, errors: string, typeDefs: string): Promise<string> {
  const numbered = code.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n")

  return await llm(
    `The generated jig code failed validation. Fix the problems.

## Validation Errors
${errors}

## Relevant Type Definitions
${typeDefs}

## Current Code (with line numbers)
${numbered}

Rules:
- Fix ONLY the reported errors.
- Do not keep placeholder behavior like "run jig connect", "once connected", or fabricated example output.
- If the code imported a connection, it must actually use relevant tools from that connection.
- Do not change the overall approach unless the current approach is invalid.
- Output ONLY the corrected TypeScript code, no explanation, no markdown fences.`,
    {},
    { maxTokens: 16384 }
  ) as string
}

// ---------------------------------------------------------------------------
// validateAndFix — shared loop for createJig and editJig
// ---------------------------------------------------------------------------

async function validateAndFix(
  filePath: string,
  code: string,
  context: AuthoringContext,
  io: JigIO,
  options: { requiresIntegration?: boolean; buildResolutions?: BuildTimeResolution[] } = {}
): Promise<string> {
  for (let attempt = 0; attempt < MAX_FIX_ATTEMPTS; attempt++) {
    const result = await validate(filePath)
    const extraErrors: string[] = []
    if (options.requiresIntegration && hasExplicitEmptyToolsArray(code)) {
      extraErrors.push("Validator behavior.empty-tools: Workflow depends on an integration, but the generated jig declares tools: []. Do not generate an integration-backed jig without real tools.")
    }
    for (const issue of collectBuildTimeToolPolicyIssues(code, options.buildResolutions ?? [])) {
      extraErrors.push(`Validator behavior.build-time-resolution.${issue.server}: ${issue.message}`)
    }
    const mergedErrors = [result.errors, ...extraErrors].filter(Boolean).join("\n")
    if (result.ok && extraErrors.length === 0) {
      io.emit({ type: "validate", ok: true })
      return code
    }
    if (attempt === MAX_FIX_ATTEMPTS - 1) {
      io.emit({ type: "validate", ok: false, errors: mergedErrors })
      throw new CreatorError("validation-failed", mergedErrors)
    }
    io.emit({ type: "validate", ok: false, errors: mergedErrors })
    io.emit({ type: "fix", attempt: attempt + 1, max: MAX_FIX_ATTEMPTS })
    code = stripCodeFences(await fixCode(code, mergedErrors, context.typeDefs))
    await writeJigSource(filePath, code)
  }
  throw new CreatorError("validation-failed", "Validation failed")
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
// dryRunAndReview — shared dry-run + LLM review
// ---------------------------------------------------------------------------

async function dryRunAndReview(
  description: string,
  code: string,
  context: AuthoringContext,
  name: string,
  io: JigIO
): Promise<string> {
  io.emit({ type: "dry-run-start" })
  const dryRunOutput = await dryRunJig(name)
  if (!dryRunOutput) return code

  const review = await reviewDryRun(description, code, dryRunOutput)
  if (review.issues) {
    io.emit({ type: "dry-run-review", ok: false, issues: review.issues })
    code = stripCodeFences(await fixFromReview(code, review.issues, context.typeDefs, dryRunOutput))
    const filePath = resolveJigPath(name)
    await writeJigSource(filePath, code, { jigId: name })
    const recheck = await validate(filePath)
    io.emit({ type: "validate", ok: recheck.ok, errors: recheck.errors })
  } else {
    io.emit({ type: "dry-run-review", ok: true })
  }
  return code
}

// ---------------------------------------------------------------------------
// dryRunJig — imports the jig definition and runs with dry-run enabled
// ---------------------------------------------------------------------------

async function dryRunJig(name: string): Promise<string | null> {
  const { runJig } = await import("./runner.js")
  const jigPath = resolveJigPath(name)
  if (!existsSync(jigPath)) return null
  const result = await runJig(jigPath, {}, () => {}, { dryRun: true, silent: true })
  return result.error ? null : (result.output.trim() || null)
}

// ---------------------------------------------------------------------------
// reviewDryRun
// ---------------------------------------------------------------------------

async function reviewDryRun(
  description: string,
  code: string,
  dryRunOutput: string
): Promise<{ issues: string | null }> {
  const result = await llm<{ ok: boolean; issues: string }>(
    `A jig was created for the goal below and dry-run tested. Review whether it works.

## User's Goal
${description}

## Generated Jig Code
${code}

## Dry-Run Output (write tools are stubbed with [dry-run])
${dryRunOutput}

Review against the user's goal:
1. Does the jig address what the user actually asked for? (e.g. if they asked for "insights from meetings", does it actually extract insights, not just list meetings?)
2. Did it successfully connect and gather relevant data?
3. Are there runtime errors, missing tools, or failures in the output?
4. For write actions (drafts, sends, etc.) — are the [dry-run] stubs showing the right intent?
5. Is the output useful and complete for the stated goal, or is it missing key parts?

If the jig accomplishes the goal correctly (even if dry-run stubs some writes), set ok=true and issues="".
If there are real problems with correctness, missing functionality, or errors, set ok=false and describe specific issues to fix in the code.`,
    {},
    { schema: { ok: "boolean", issues: "string" } }
  )

  return { issues: result.ok ? null : result.issues }
}

// ---------------------------------------------------------------------------
// fixFromReview
// ---------------------------------------------------------------------------

async function fixFromReview(
  code: string,
  issues: string,
  typeDefs: string,
  dryRunOutput: string
): Promise<string> {
  return await llm(
    `The jig code was dry-run tested and an LLM review found issues:

## Issues Found
${issues}

## Dry-Run Output
${dryRunOutput}

## Type Definitions
${typeDefs}

## Current Code
${code}

Fix the issues. Output ONLY the corrected TypeScript code, no explanation, no markdown fences.`,
    {},
    { maxTokens: 16384 }
  ) as string
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

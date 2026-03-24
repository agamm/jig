/**
 * Jig Creator — AI-powered jig generation and editing.
 *
 * Abstract module with no CLI coupling. All I/O goes through JigIO.emit()
 * with structured events — the presentation layer decides how to render.
 */
import { join, relative, resolve } from "path"
import { existsSync, readFileSync } from "fs"
import ts from "typescript"
import { llm, agent } from "./sdk/llm.js"
import { createLazyServer } from "./sdk/connections.js"
import { isReadTool } from "./sdk/dryrun.js"
import { discoverJigs } from "./discover.js"
import { loadServerConfigs } from "./mcp/config.js"
import type { JigTool } from "./sdk/jig.js"

const PROJECT_ROOT = join(import.meta.dir, "..")
const SCHEMAS_DIR = join(PROJECT_ROOT, ".jig/schemas")
const TYPES_DIR = join(PROJECT_ROOT, ".jig/types")
const JIGS_DIR = join(PROJECT_ROOT, "jigs")
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
  | { type: "server-list"; servers: { name: string; connected: boolean; toolCount: number; description: string }[] }
  | { type: "connecting"; server: string }
  | { type: "tools-discovered"; server: string; count: number; tools: string[] }
  | { type: "server-ready"; server: string }
  // Run events
  | { type: "jig-list"; jigs: { name: string; entities: string[] }[] }
  | { type: "entity-list"; name: string; entities: string[] }
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

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface CreatorContext {
  skillMd: string
  typeDefs: string
  toolCatalog: string
  relevantSchemas: string
  exampleJig: string
  serverDescriptions: string
}

// ---------------------------------------------------------------------------
// createJig
// ---------------------------------------------------------------------------

export async function createJig(description: string, io: JigIO): Promise<CreateResult> {
  // 1. Plan: identify servers, tool prefixes, and filename in one LLM call
  const serverConfigs = await loadServerConfigs()
  const plan = await planJig(description, serverConfigs)

  // 2. Emit plan so user sees what the creator understood
  io.emit({ type: "plan", servers: plan.servers, relevantTools: plan.relevantTools, name: plan.name })

  // 3. Check connections
  checkConnections(plan.servers, plan.unknownServers, serverConfigs, io)

  // 4. Check filename
  const name = plan.name
  const targetPath = join(JIGS_DIR, `${name}.ts`)
  if (existsSync(targetPath)) {
    io.emit({ type: "error", code: "file-exists", message: `jigs/${name}.ts already exists`, details: { name, suggestion: `jig edit ${name}` } })
    throw new CreatorError("file-exists", `jigs/${name}.ts already exists`)
  }

  // 5. Assemble context
  const context = await assembleContext(plan.servers, plan.relevantTools)

  // 6. Probe — scoped to relevant tools only
  const readTools = loadReadOnlyTools(plan.servers, plan.relevantTools)
  io.emit({ type: "probe-start", tools: readTools.map(t => `${t._serverName}.${t._toolName}`) })
  const probeResults = await probe(description, readTools, context.toolCatalog)
  io.emit({ type: "probe-done", summary: probeResults })

  // 7. Generate
  io.emit({ type: "generate-start" })
  let code = await generateJigCode(description, probeResults, context, { importPrefix: ".." })
  code = stripCodeFences(code)

  // 8. Write + validate + fix loop
  const relFile = `jigs/${name}.ts`
  io.emit({ type: "write", file: relFile })
  await Bun.write(targetPath, code)
  code = await validateAndFix(targetPath, code, context, io)

  // 9. Dry-run + LLM review
  code = await dryRunAndReview(description, code, context, name, undefined, io)
  // Final write ensures file matches returned code even if dryRunAndReview
  // found no issues (validateAndFix already wrote, but code may differ after dry-run fix)
  await Bun.write(targetPath, code)

  io.emit({ type: "created", name, file: relFile })
  return { path: targetPath, name, code }
}

// ---------------------------------------------------------------------------
// editJig
// ---------------------------------------------------------------------------

export async function editJig(
  name: string,
  entity: string | undefined,
  instruction: string,
  io: JigIO
): Promise<CreateResult> {
  const jigs = discoverJigs(JIGS_DIR)
  if (!jigs.has(name)) {
    io.emit({ type: "error", code: "jig-not-found", message: `Jig not found: ${name}` })
    throw new CreatorError("jig-not-found", `Jig not found: ${name}`)
  }

  const entities = jigs.get(name)!
  let targetPath: string
  let importPrefix: string

  if (entities.length === 0) {
    targetPath = join(JIGS_DIR, `${name}.ts`)
    importPrefix = ".."
  } else if (!entity) {
    io.emit({ type: "error", code: "entity-required", message: `"${name}" is a grouped jig`, details: { entities, commands: entities.map(e => `jig edit ${name} ${e}`) } })
    throw new CreatorError("entity-required", `"${name}" is a grouped jig — specify an entity`)
  } else if (!entities.includes(entity)) {
    io.emit({ type: "error", code: "entity-not-found", message: `Entity not found: ${name}/${entity}`, details: { available: entities } })
    throw new CreatorError("entity-not-found", `Entity not found: ${name}/${entity}`)
  } else {
    targetPath = join(JIGS_DIR, name, `${entity}.ts`)
    importPrefix = "../.."
  }

  const existingCode = await Bun.file(targetPath).text()

  // Check if instruction needs new servers
  const serverConfigs = await loadServerConfigs()
  const plan = await planJig(instruction, serverConfigs)
  const importedServers = extractImportedServers(existingCode)
  const newServers = plan.servers.filter(s => !importedServers.includes(s))

  if (newServers.length > 0 || plan.unknownServers.length > 0) {
    checkConnections(newServers, plan.unknownServers, serverConfigs, io)
  }

  const allServers = [...new Set([...importedServers, ...plan.servers])]
  const context = await assembleContext(allServers, plan.relevantTools)

  // Probe only for new servers, scoped to relevant tools
  let probeResults = ""
  if (newServers.length > 0) {
    const readTools = loadReadOnlyTools(newServers, plan.relevantTools)
    io.emit({ type: "probe-start", tools: readTools.map(t => `${t._serverName}.${t._toolName}`) })
    probeResults = await probe(instruction, readTools, context.toolCatalog)
    io.emit({ type: "probe-done", summary: probeResults })
  }

  io.emit({ type: "generate-start" })
  let code = await generateJigCode(instruction, probeResults, context, {
    importPrefix,
    edit: { existingCode },
  })
  code = stripCodeFences(code)

  await Bun.write(targetPath, code)
  code = await validateAndFix(targetPath, code, context, io)
  code = await dryRunAndReview(instruction, code, context, name, entity, io)
  await Bun.write(targetPath, code)

  const displayName = entity ? `${name} ${entity}` : name
  const relFile = relative(PROJECT_ROOT, targetPath)
  io.emit({ type: "updated", name: displayName, file: relFile })
  return { path: targetPath, name: displayName, code }
}

// ---------------------------------------------------------------------------
// planJig — single LLM call: servers, relevant tools, filename
// ---------------------------------------------------------------------------

interface JigPlan {
  servers: string[]
  unknownServers: string[]
  relevantTools: string[]
  name: string
}

async function planJig(
  description: string,
  serverConfigs: Record<string, any>
): Promise<JigPlan> {
  const entries = Object.entries(serverConfigs)
  const serverList = entries
    .map(([name, cfg]) => `  "${name}": ${(cfg as any).description}`)
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

  // Build tool list per server from schemas
  const toolsByServer = entries
    .map(([name]) => {
      const schemaPath = join(SCHEMAS_DIR, `${name}.json`)
      if (!existsSync(schemaPath)) return ""
      const schemas: any[] = JSON.parse(readFileSync(schemaPath, "utf-8"))
      const toolList = schemas.map(t => `${t.name}: ${t.description?.split("\n")[0] ?? ""}`)
      return `  "${name}":\n    ${toolList.join("\n    ")}`
    })
    .filter(Boolean)
    .join("\n")

  const result = await llm<{
    servers: string[]; unknownServers: string[]; relevantTools: string[]; name: string
  }>(
    `Plan a workflow automation.

## Available servers (use ONLY these key names)
${serverList}

${keywordHints}

## Tools by server
${toolsByServer}

## Task
For this workflow: "${description}"

1. "servers": which server keys does this need?
2. "unknownServers": services mentioned that don't match any server above
3. "relevantTools": which specific tool names from the lists above would this workflow use? Only include tools it actually needs.
4. "name": a short kebab-case filename, 2-3 words, descriptive`,
    {},
    { schema: { servers: "array", unknownServers: "array", relevantTools: "array", name: "string" } as any }
  )

  const validServers = (result.servers || []).filter(s => s in serverConfigs)
  const invalidServers = (result.servers || []).filter(s => !(s in serverConfigs))

  const safeName = (result.name || "new-jig")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    || "new-jig"

  return {
    servers: validServers,
    unknownServers: [...(result.unknownServers || []), ...invalidServers],
    relevantTools: result.relevantTools || [],
    name: safeName,
  }
}

// ---------------------------------------------------------------------------
// checkConnections — emits structured events, throws on missing
// ---------------------------------------------------------------------------

function checkConnections(
  knownServers: string[],
  unknownServers: string[],
  serverConfigs: Record<string, any>,
  io: JigIO
): void {
  const servers = knownServers.map(s => ({
    name: s,
    connected: existsSync(join(SCHEMAS_DIR, `${s}.json`)),
    description: (serverConfigs[s] as any)?.description ?? "",
  }))

  io.emit({ type: "connections", servers })

  const missing = servers.filter(s => !s.connected)
  if (missing.length > 0) {
    io.emit({
      type: "connections-missing",
      servers: missing.map(s => ({ name: s.name, command: `jig connect ${s.name}` })),
    })
  }

  if (unknownServers.length > 0) {
    io.emit({ type: "connections-unknown", servers: unknownServers.map(name => ({ name })) })
  }

  if (missing.length > 0 || unknownServers.length > 0) {
    throw new CreatorError("missing-connections", "Required connections are not set up")
  }
}

export class CreatorError extends Error {
  constructor(public code: string, message: string) {
    super(message)
  }
}

// ---------------------------------------------------------------------------
// loadReadOnlyTools
// ---------------------------------------------------------------------------

function loadReadOnlyTools(servers: string[], relevantTools?: string[]): JigTool<any, any>[] {
  const tools: JigTool<any, any>[] = []
  const toolSet = relevantTools?.length ? new Set(relevantTools) : null

  for (const serverName of servers) {
    const schemaPath = join(SCHEMAS_DIR, `${serverName}.json`)
    if (!existsSync(schemaPath)) continue

    const schemas: any[] = JSON.parse(readFileSync(schemaPath, "utf-8"))
    const readToolNames = schemas
      .filter(t => isReadTool(t.name))
      .filter(t => !toolSet || toolSet.has(t.name))
      .map(t => t.name)
    if (readToolNames.length === 0) continue

    const server = createLazyServer(serverName, readToolNames)
    for (const name of readToolNames) {
      tools.push(server[name])
    }
  }

  return tools
}

// ---------------------------------------------------------------------------
// assembleContext
// ---------------------------------------------------------------------------

async function assembleContext(servers: string[], relevantToolNames?: string[]): Promise<CreatorContext> {
  const skillPath = join(PROJECT_ROOT, "SKILL.md")
  const skillMd = existsSync(skillPath) ? await Bun.file(skillPath).text() : ""

  const typeDefs = servers
    .map(s => {
      const p = join(TYPES_DIR, `${s}.d.ts`)
      return existsSync(p) ? `// --- ${s}.d.ts ---\n${readFileSync(p, "utf-8")}` : ""
    })
    .filter(Boolean)
    .join("\n\n")

  let toolCatalog = ""
  let relevantSchemas = ""
  for (const serverName of servers) {
    const schemaPath = join(SCHEMAS_DIR, `${serverName}.json`)
    if (!existsSync(schemaPath)) continue
    const allSchemas: any[] = JSON.parse(readFileSync(schemaPath, "utf-8"))
    // Catalog: all tools (so the LLM knows what exists)
    toolCatalog += `\n## ${serverName}\n`
    for (const t of allSchemas) {
      toolCatalog += `  ${t.name}: ${t.description?.split("\n")[0] ?? ""}\n`
    }
    // Schemas: only relevant tools (so the LLM gets exact params without noise)
    const toolSet = relevantToolNames?.length ? new Set(relevantToolNames) : null
    const scoped = toolSet
      ? allSchemas.filter(t => toolSet.has(t.name))
      : allSchemas
    if (scoped.length > 0) {
      relevantSchemas += `\n## ${serverName} tool schemas\n${JSON.stringify(scoped)}\n`
    }
  }

  const examplePath = join(JIGS_DIR, "weekly-update.ts")
  const exampleJig = existsSync(examplePath) ? await Bun.file(examplePath).text() : ""

  const configs = await loadServerConfigs()
  const serverDescriptions = servers
    .map(s => `${s}: ${(configs as any)[s]?.description ?? ""}`)
    .join("\n")

  return { skillMd, typeDefs, toolCatalog, relevantSchemas, exampleJig, serverDescriptions }
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

// ---------------------------------------------------------------------------
// generateJigCode
// ---------------------------------------------------------------------------

async function generateJigCode(
  description: string,
  probeResults: string,
  context: CreatorContext,
  options: { importPrefix: string; edit?: { existingCode: string } }
): Promise<string> {
  const isEdit = !!options.edit

  let prompt = `${context.typeDefs}

${context.skillMd}

## Available Connections
${context.serverDescriptions}

## Tool Catalog
${context.toolCatalog}

## Tool Schemas (exact param names, types, required fields)
${context.relevantSchemas}

## Probe Results (real data from the user's connected services)
${probeResults}

## Example Jig (for reference)
\`\`\`typescript
${context.exampleJig}
\`\`\`
`

  if (isEdit) {
    prompt += `
## Existing Jig Code (to modify)
\`\`\`typescript
${options.edit!.existingCode}
\`\`\`

## Edit Instruction
${description}

Modify the existing jig code according to the instruction. Preserve the existing structure and only change what's needed.
`
  } else {
    prompt += `
## Task
Create a new jig that does the following:
${description}
`
  }

  prompt += `
## Rules
- Output ONLY TypeScript code. No explanation, no markdown fences.
- Import SDK from "${options.importPrefix}/src/index.js" (jig, llm, agent)
- Import connections from "${options.importPrefix}/.jig/connections/{server}.js"
- Follow SKILL.md patterns: agent() for fuzzy gathering, llm() for content generation, direct tool calls for actions
- Use exact param names and types from the type definitions above
- Separate gather tools (given to agent) from action tools (called directly)
- Use ctx.log() for output, NEVER console.log()
- End the file with: export default myJig (do NOT call run() or process.exit())
- Do NOT use require() or CommonJS imports
- Do NOT add markdown fences around the code`

  const result = await llm(prompt, {}, { maxTokens: 16384 })
  return result as string
}

// ---------------------------------------------------------------------------
// validate (programmatic tsc, filtered to target file)
// ---------------------------------------------------------------------------

async function validate(filePath: string): Promise<{ ok: boolean; errors?: string }> {
  const tsconfigPath = join(PROJECT_ROOT, "tsconfig.json")
  const configFile = ts.readConfigFile(tsconfigPath, p => readFileSync(p, "utf-8"))
  const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, PROJECT_ROOT)

  const program = ts.createProgram([filePath], { ...parsedConfig.options, noEmit: true })
  const diagnostics = ts.getPreEmitDiagnostics(program)

  const fileErrors = diagnostics.filter(d =>
    d.file && resolve(d.file.fileName) === resolve(filePath)
  )

  if (fileErrors.length === 0) return { ok: true }

  const formatted = fileErrors.map(d => {
    const { line } = d.file!.getLineAndCharacterOfPosition(d.start!)
    const msg = ts.flattenDiagnosticMessageText(d.messageText, "\n")
    return `Line ${line + 1}: ${msg}`
  }).join("\n")

  return { ok: false, errors: formatted }
}

// ---------------------------------------------------------------------------
// fixCode
// ---------------------------------------------------------------------------

async function fixCode(code: string, errors: string, typeDefs: string): Promise<string> {
  const numbered = code.split("\n").map((l, i) => `${i + 1}: ${l}`).join("\n")

  return await llm(
    `The generated jig code has TypeScript errors. Fix them.

## Errors
${errors}

## Relevant Type Definitions
${typeDefs}

## Current Code (with line numbers)
${numbered}

Rules: Fix ONLY the errors. Do not change the overall approach. Output ONLY the corrected TypeScript code, no explanation, no markdown fences.`,
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
  context: CreatorContext,
  io: JigIO
): Promise<string> {
  for (let attempt = 0; attempt < MAX_FIX_ATTEMPTS; attempt++) {
    const result = await validate(filePath)
    if (result.ok) {
      io.emit({ type: "validate", ok: true })
      return code
    }
    if (attempt === MAX_FIX_ATTEMPTS - 1) {
      io.emit({ type: "validate", ok: false, errors: result.errors })
      return code
    }
    io.emit({ type: "validate", ok: false, errors: result.errors })
    io.emit({ type: "fix", attempt: attempt + 1, max: MAX_FIX_ATTEMPTS })
    code = stripCodeFences(await fixCode(code, result.errors!, context.typeDefs))
    await Bun.write(filePath, code)
  }
  return code
}

// ---------------------------------------------------------------------------
// dryRunAndReview — shared dry-run + LLM review
// ---------------------------------------------------------------------------

async function dryRunAndReview(
  description: string,
  code: string,
  context: CreatorContext,
  name: string,
  entity: string | undefined,
  io: JigIO
): Promise<string> {
  io.emit({ type: "dry-run-start" })
  const dryRunOutput = await dryRunJig(name, entity)
  if (!dryRunOutput) return code

  const review = await reviewDryRun(description, code, dryRunOutput)
  if (review.issues) {
    io.emit({ type: "dry-run-review", ok: false, issues: review.issues })
    code = stripCodeFences(await fixFromReview(code, review.issues, context.typeDefs, dryRunOutput))
    // Write + re-validate after review fix
    const filePath = entity
      ? join(JIGS_DIR, name, `${entity}.ts`)
      : join(JIGS_DIR, `${name}.ts`)
    await Bun.write(filePath, code)
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

async function dryRunJig(name: string, entity?: string): Promise<string | null> {
  const { run } = await import("./sdk/jig.js")
  const { setDryRun } = await import("./sdk/dryrun.js")

  const jigPath = entity
    ? join(JIGS_DIR, name, `${entity}.ts`)
    : join(JIGS_DIR, `${name}.ts`)

  if (!existsSync(jigPath)) return null

  setDryRun(true)
  try {
    const mod = await import(`${jigPath}?_dryrun=${Date.now()}`)
    const ctx = await run(mod.default, {}, { silent: true })
    return ctx.getOutput().join("\n").trim() || null
  } catch (e) {
    return `Error: ${(e as Error).message}`
  } finally {
    setDryRun(false)
  }
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
    `Review this jig's dry-run output. Does it look correct for the stated goal?

## Goal
${description}

## Jig Code
${code}

## Dry-Run Output
${dryRunOutput}

Check:
1. Did the jig connect to the right services?
2. Did it gather relevant data (or show [dry-run] stubs for write operations)?
3. Are there any runtime errors, missing tools, or unexpected failures?
4. Does the output structure match what the goal requires?

If everything looks good, set ok=true and issues="".
If there are problems, set ok=false and describe the specific issues to fix.`,
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
  const matches = code.matchAll(/from\s+["'].*\.jig\/connections\/(\w+)\.js["']/g)
  return [...matches].map(m => m[1])
}

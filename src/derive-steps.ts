/**
 * Derive steps from jig source code by parsing ctx.step() calls.
 * No handler execution, no LLM, no proxies — just regex on source.
 */
import type { CachedStep, CachedStepTool } from "./db.js"
import { getConnectionImportBindings } from "./domain/source-analysis.js"
import { extractJigModel, readObjectLiteral } from "./domain/jig-source.js"
import { getMainModel } from "./config/models.js"

function parseConnectionImports(code: string): Map<string, string> {
  return new Map(getConnectionImportBindings(code).map((binding) => [binding.localName, binding.serverName]))
}

function inferReadOnly(toolName: string): boolean {
  const writeVerbs = ["send", "create", "update", "delete", "draft", "write", "remove", "post"]
  const lower = toolName.toLowerCase()
  return !writeVerbs.some(v => lower.includes(v))
}

export function isUsableCachedSteps(steps: CachedStep[]): boolean {
  return steps.length > 0 && steps.every(s => s.name.trim().length > 0)
}

/** Parse tool array variables: const gatherTools = [workspace.gmail_search, ...] */
function parseToolArrayVars(code: string, connections: Map<string, string>): Map<string, CachedStepTool[]> {
  const vars = new Map<string, CachedStepTool[]>()
  // Match: const varName = [tool1, tool2, ...]
  const re = /(?:const|let)\s+(\w+)\s*=\s*\[([\s\S]*?)\]/g
  for (const m of code.matchAll(re)) {
    const varName = m[1]
    const block = m[2]
    const toolRefs = [...block.matchAll(/(\w+)\.(\w+)/g)]
    if (toolRefs.length === 0) continue
    const tools: CachedStepTool[] = []
    for (const ref of toolRefs) {
      const connVar = ref[1]
      const toolName = ref[2]
      const serverName = connections.get(connVar) ?? connVar
      tools.push({ connection: serverName, name: toolName, readOnly: inferReadOnly(toolName) })
    }
    vars.set(varName, tools)
  }
  return vars
}

function resolveToolsBlock(block: string, connections: Map<string, string>, toolVars: Map<string, CachedStepTool[]>): CachedStepTool[] {
  const tools: CachedStepTool[] = []
  // Inline tool refs: workspace.gmail_search
  for (const ref of block.matchAll(/(\w+)\.(\w+)/g)) {
    const connVar = ref[1]
    const toolName = ref[2]
    const serverName = connections.get(connVar) ?? connVar
    tools.push({ connection: serverName, name: toolName, readOnly: inferReadOnly(toolName) })
  }
  // Spread variable refs: ...gatherTools
  for (const ref of block.matchAll(/\.\.\.(\w+)/g)) {
    const varTools = toolVars.get(ref[1])
    if (varTools) tools.push(...varTools)
  }
  // Bare variable refs (no spread, no dot): gatherTools
  for (const ref of block.matchAll(/(?<!\.)(?<!\w)([a-zA-Z_]\w*)(?!\s*\.|\s*\()/g)) {
    if (ref[1] === "async" || ref[1] === "await") continue
    const varTools = toolVars.get(ref[1])
    if (varTools) tools.push(...varTools)
  }
  return tools
}

/**
 * The `model` in a step's fourth argument, `ctx.step(label, tools, async () => {...}, { model })`.
 * `from` points just past `async`; the callback body is brace-matched first so
 * an `llm(..., { model })` call inside it is not mistaken for the step option.
 */
function parseStepModelOption(code: string, from: number): string | null {
  // Arrow callbacks only: `async function () {` has its brace before any `=>`.
  const arrow = code.indexOf("=>", from)
  const brace = code.indexOf("{", from)
  if (arrow === -1 || brace === -1 || brace < arrow) return null
  let bodyStart = arrow + 2
  while (bodyStart < code.length && /\s/.test(code[bodyStart])) bodyStart++
  const body = readObjectLiteral(code, bodyStart)
  if (!body) return null
  const afterBody = bodyStart + body.length
  const comma = /^\s*,/.exec(code.slice(afterBody))
  if (!comma) return null
  const options = readObjectLiteral(code, afterBody + comma[0].length)
  const match = options?.match(/\bmodel\s*:\s*["'`]([^"'`]+)["'`]/)
  return match?.[1]?.trim() || null
}

export function parseStepsFromSource(code: string): CachedStep[] {
  const connections = parseConnectionImports(code)
  const toolVars = parseToolArrayVars(code, connections)
  // Chip labels follow the runtime precedence: call > step > jig > global main model.
  const jigModel = extractJigModel(code) ?? getMainModel()
  const shortLabel = (id: string) => id.split("/").pop() ?? id

  // Match both: ctx.step("label", [inline], async  AND  ctx.step("label", varRef, async
  const stepRegex = /ctx\.step\(\s*["'`]([^"'`]+)["'`]\s*,\s*(\[[^\]]*\]|\w+)\s*,\s*async/g
  const matches = [...code.matchAll(stepRegex)]
  const steps: CachedStep[] = []

  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]
    const name = match[1]
    const toolsArg = match[2]

    let tools: CachedStepTool[]
    if (toolsArg.startsWith("[")) {
      tools = resolveToolsBlock(toolsArg, connections, toolVars)
    } else {
      tools = toolVars.get(toolsArg) ?? []
    }

    // Scan the step body for llm() and agent() calls, extract model if specified
    const bodyStart = match.index! + match[0].length
    const bodyEnd = matches[i + 1]?.index ?? code.length
    const body = code.slice(bodyStart, bodyEnd)
    const stepModel = parseStepModelOption(code, bodyStart) ?? jigModel
    if (/\bllm\s*[<(]/.test(body)) {
      const modelMatch = body.match(/\bllm\s*(?:<[^>]*>)?\s*\([^)]*\{[^}]*model\s*:\s*["']([^"']+)["']/)
      tools.push({ connection: "llm", name: `llm(${shortLabel(modelMatch?.[1] ?? stepModel)})`, readOnly: true })
    }
    if (/\bagent\s*[<(]/.test(body)) {
      const modelMatch = body.match(/\bagent\s*(?:<[^>]*>)?\s*\([^)]*\{[^}]*model\s*:\s*["']([^"']+)["']/)
      tools.push({ connection: "llm", name: `agent(${shortLabel(modelMatch?.[1] ?? stepModel)})`, readOnly: true })
    }

    const stepConnections = [...new Set(tools.map(t => t.connection))]
    steps.push({ num: i + 1, name, connections: stepConnections, tools })
  }

  return steps
}

export async function deriveSteps(jigId: string, code: string): Promise<CachedStep[]> {
  const { getStepCache, setStepCache } = await import("./db.js")
  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(code)
  // Chip labels fall back to the global main model, so a new default must miss the cache.
  hasher.update(getMainModel())
  const codeHash = hasher.digest("hex")

  const cached = getStepCache(jigId, codeHash)
  if (cached && cached.length > 0) return cached

  const steps = parseStepsFromSource(code)
  if (steps.length > 0) {
    try { setStepCache(jigId, codeHash, steps) } catch {}
  }
  return steps
}

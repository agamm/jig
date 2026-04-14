import { readFileSync } from "fs"
import type { JigTool, ToolPermission } from "../../shared/api.js"
import { extractConnections, extractTrigger, getJigFilePath } from "../domain/jig-source.js"
import { getToolPermission } from "../db.js"

function dedupeTools(tools: JigTool[]): JigTool[] {
  return [...new Map(tools.map((tool) => [`${tool.connection}:${tool.name}`, tool])).values()]
}

export interface IntrospectedJig {
  id: string
  filePath: string | null
  code: string
  trigger: string
  tools: JigTool[]
  connections: string[]
  steps: import("../../shared/api.js").JigStep[]
  permissions: ToolPermission[]
}

export async function introspectJig(
  id: string,
  options: {
    includeSteps?: boolean
    filePathOverride?: string | null
    codeOverride?: string
  } = {}
): Promise<IntrospectedJig> {
  const filePath = options.filePathOverride ?? getJigFilePath(id)
  let code = options.codeOverride ?? ""
  try {
    if (!code && filePath) code = readFileSync(filePath, "utf-8")
  } catch {}

  let trigger = code ? extractTrigger(code) : ""
  let tools: JigTool[] = []
  let steps: import("../../shared/api.js").JigStep[] = []

  if (filePath) {
    try {
      const mod = await import(`${filePath}?_t=${Date.now()}_${Math.random().toString(36).slice(2)}`)
      const def = mod.default
      if (def?.options?.tools?.length) {
        tools = dedupeTools(def.options.tools.map((tool: any) => ({
          connection: tool._serverName,
          name: tool._toolName,
          readOnly: tool._readOnly === true,
        })))
      }
    } catch {
      trigger = extractTrigger(code)
    }
  }

  if (options.includeSteps && code) {
    const { deriveSteps } = await import("../derive-steps.js")
    steps = await deriveSteps(id, code)
  }

  const connections = tools.length > 0
    ? [...new Set(tools.map((tool) => tool.connection))]
    : extractConnections(code)

  const permissions: ToolPermission[] = tools.map((tool) => ({
    connection: tool.connection,
    tool: tool.name,
    policy: getToolPermission(tool.connection, tool.name) ?? "ask",
  }))

  return {
    id,
    filePath,
    code,
    trigger,
    tools,
    connections,
    steps,
    permissions,
  }
}

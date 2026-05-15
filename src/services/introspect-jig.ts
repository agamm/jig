import type { JigTool, ToolPermission } from "../../shared/api.js"
import { extractConnections, extractTrigger } from "../domain/jig-source.js"
import { getToolPermission } from "../db.js"
import { getActiveCode } from "./jig-store.js"
import { materializeActiveVersion } from "./jig-runtime.js"

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
  /** Model declared in the jig source via `jig(id, {model: "..."}, ...)`. */
  modelInCode: string | null
}

export async function introspectJig(
  id: string,
  options: {
    includeSteps?: boolean
    filePathOverride?: string | null
    codeOverride?: string
  } = {}
): Promise<IntrospectedJig> {
  // v12: source of truth is the materialized active version from the store.
  // codeOverride / filePathOverride are used by the agent's draft-preview flow.
  let filePath: string | null = options.filePathOverride ?? null
  let code = options.codeOverride ?? ""

  if (!filePath && !code) {
    const materialized = await materializeActiveVersion(id)
    if (materialized) {
      filePath = materialized.path
      code = getActiveCode(id) ?? ""
    }
  }

  let trigger = code ? extractTrigger(code) : ""
  let tools: JigTool[] = []
  let steps: import("../../shared/api.js").JigStep[] = []
  let modelInCode: string | null = null

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
      if (typeof def?.options?.model === "string" && def.options.model.trim().length > 0) {
        modelInCode = def.options.model.trim()
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
    modelInCode,
  }
}

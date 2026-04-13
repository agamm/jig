import { toolNameToIdentifier } from "./mcp/typegen.js"
import { firstLineSummary } from "./text.js"

type CatalogTool = {
  name: string
  description?: string | null
}

export function renderCodeFacingToolCatalogSection(serverName: string, tools: CatalogTool[]): string {
  return `## ${serverName} tools\n${tools.map((tool) => renderCodeFacingToolCatalogLine(serverName, tool)).join("\n")}`
}

function renderCodeFacingToolCatalogLine(serverName: string, tool: CatalogTool): string {
  const identifier = toolNameToIdentifier(tool.name)
  const desc = firstLineSummary(tool.description)
  return identifier === tool.name
    ? `  ${serverName}.${identifier}: ${desc}`
    : `  ${serverName}.${identifier} (MCP tool: "${tool.name}"): ${desc}`
}

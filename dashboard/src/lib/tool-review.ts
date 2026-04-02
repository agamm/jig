"use client"

import type { JigStepTool, JigTool } from "@shared/api"

type ToolLike = Pick<JigStepTool, "connection" | "name" | "readOnly">

export function toolKey(tool: ToolLike) {
  return `${tool.connection}:${tool.name}:${tool.readOnly ? "ro" : "rw"}`
}

export function sameTool(a: ToolLike, b: ToolLike) {
  return toolKey(a) === toolKey(b)
}

export function formatToolNames<T extends ToolLike>(tools: T[]) {
  const names = tools.map((tool) => tool.name)
  if (names.length === 0) return ""
  if (names.length === 1) return names[0]
  if (names.length === 2) return `${names[0]} and ${names[1]}`
  return `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`
}

export function buildRemovalInstruction<T extends ToolLike>(tools: T[]) {
  if (tools.length === 0) return ""
  return `Remove ${formatToolNames(tools)} from this jig and adjust the workflow if needed.`
}

export function getReviewableToolKeys(steps: { tools?: JigStepTool[] }[], tools: JigTool[]) {
  const keys = new Set<string>()
  for (const step of steps) {
    for (const tool of step.tools ?? []) keys.add(toolKey(tool))
  }
  // Always include declared tools — step scan may not reach all code paths
  for (const tool of tools) keys.add(toolKey(tool))
  return keys
}

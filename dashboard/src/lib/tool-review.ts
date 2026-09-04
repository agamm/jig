"use client"

import type { JigStepTool, JigTool } from "@shared/api"

type ToolLike = Pick<JigStepTool, "connection" | "name" | "readOnly">

export function toolKey(tool: ToolLike) {
  return `${tool.connection}:${tool.name}:${tool.readOnly ? "ro" : "rw"}`
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

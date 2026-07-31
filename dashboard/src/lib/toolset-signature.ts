import type { JigTool } from "@shared/api"

/**
 * Pure toolset helpers, deliberately free of React and of "use client".
 *
 * The engine test suite imports getToolsetSignature directly, and CI's engine
 * job installs only the root dependencies — dashboard deps live under pnpm in
 * dashboard/node_modules. Keeping this logic out of the hook module means
 * neither `bun test` nor `tsc --noEmit` has to resolve `react`.
 */
export function normalizeTools(tools: JigTool[]): JigTool[] {
  return [...tools]
    .sort((a, b) =>
      `${a.connection}:${a.name}:${a.readOnly}`.localeCompare(`${b.connection}:${b.name}:${b.readOnly}`)
    )
}

export function getToolsetSignature(tools: JigTool[]): string {
  return normalizeTools(tools)
    .map((tool) => `${tool.connection}:${tool.name}:${tool.readOnly ? "ro" : "rw"}`)
    .join("|")
}

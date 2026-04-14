import { validateApifyBuildTimeResolution } from "./apify.js"
import type { ConnectorBuildTimeValidator } from "./types.js"

const validators: Record<string, ConnectorBuildTimeValidator> = {
  apify: validateApifyBuildTimeResolution,
}

export function getConnectorBuildTimeValidator(serverName: string): ConnectorBuildTimeValidator | null {
  return validators[serverName] ?? null
}

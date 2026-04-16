import type { Connection } from "@shared/api"

export const RECOMMENDED_CONNECTIONS = ["composio", "apify", "workspace"] as const

const RECOMMENDED_SET = new Set<string>(RECOMMENDED_CONNECTIONS)

export function isRecommendedConnection(name: string): boolean {
  return RECOMMENDED_SET.has(name.toLowerCase())
}

export function sortConnectionsForDisplay(connections: Connection[]): Connection[] {
  const byName = new Map(connections.map((connection) => [connection.name.toLowerCase(), connection]))
  const recommended = RECOMMENDED_CONNECTIONS
    .map((name) => byName.get(name))
    .filter((connection): connection is Connection => !!connection)
  const rest = connections.filter((connection) => !isRecommendedConnection(connection.name))
  return [...recommended, ...rest]
}

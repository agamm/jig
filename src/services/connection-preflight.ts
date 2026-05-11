import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { CONNECTIONS_DIR, SCHEMAS_DIR } from "../config/paths.js"
import { extractConnections } from "../domain/jig-source.js"

export function missingConnectionsForJig(jigPath: string): string[] {
  const code = readFileSync(jigPath, "utf-8")
  return extractConnections(code).filter((name) => {
    const schemaExists = existsSync(join(SCHEMAS_DIR, `${name}.json`))
    const moduleExists = existsSync(join(CONNECTIONS_DIR, `${name}.ts`))
    return !schemaExists || !moduleExists
  })
}

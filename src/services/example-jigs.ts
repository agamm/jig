import { existsSync, readFileSync } from "fs"
import type { ExampleJig } from "../../shared/api.js"
import { EXAMPLES_DIR } from "../config/paths.js"
import { prettifyId, extractConnections, extractTrigger } from "../domain/jig-source.js"
import { discoverJigs } from "../discover.js"
import { parseStepsFromSource } from "../derive-steps.js"
import { isValidJigId } from "../domain/jig-id.js"
import { approvePending, getJigRow, writePending } from "./jig-store.js"
import { invalidateJigsCache } from "../discover.js"

function extractDescription(code: string, fallback: string): string {
  const summaryMatch = code.match(/^\s*\/\/\s*(.+)$/m)
  if (summaryMatch) return summaryMatch[1].trim()

  const blockMatch = code.match(/\/\*\*([\s\S]*?)\*\//)
  if (blockMatch) {
    const line = blockMatch[1]
      .split("\n")
      .map((part) => part.replace(/^\s*\*\s?/, "").trim())
      .find(Boolean)
    if (line) return line
  }

  return fallback
}

export function listExampleJigs(): ExampleJig[] {
  if (!existsSync(EXAMPLES_DIR)) return []

  return [...discoverJigs(EXAMPLES_DIR).keys()]
    .sort()
    .map((id) => {
      const filePath = `${EXAMPLES_DIR}/${id}.ts`
      const code = readFileSync(filePath, "utf-8")
      const name = prettifyId(id)
      return {
        id,
        name,
        trigger: extractTrigger(code) || "Manual",
        description: extractDescription(code, `${name} example jig.`),
        connections: extractConnections(code),
        steps: parseStepsFromSource(code),
      }
    })
}

export function readExampleJigSource(id: string): string {
  if (!isValidJigId(id)) throw new Error("Invalid example jig id")
  const filePath = `${EXAMPLES_DIR}/${id}.ts`
  if (!existsSync(filePath)) throw new Error(`Example jig not found: ${id}`)
  return readFileSync(filePath, "utf-8")
}

export async function addExampleJig(id: string): Promise<string> {
  const code = readExampleJigSource(id)
  if (getJigRow(id)) throw new Error(`Jig already exists: ${id}`)
  // Install the example as an immediately-active version. No pending — the user
  // explicitly chose to add a curated example, no review gate needed.
  writePending({ jigId: id, code, author: "cli", message: "imported from examples" })
  approvePending(id)
  invalidateJigsCache()
  return id
}

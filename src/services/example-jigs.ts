import { existsSync, readFileSync, readdirSync } from "fs"
import type { ExampleJig } from "../../shared/api.js"
import { EXAMPLES_DIR } from "../config/paths.js"
import { prettifyId, extractConnections, extractTrigger } from "../domain/jig-source.js"

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

/** Consecutive non-empty `//` lines opening the file: the summary, then the "Uses ..." sentence. */
function headerComments(code: string): string[] {
  const lines: string[] = []
  for (const line of code.split("\n")) {
    const text = line.match(/^\s*\/\/\s*(.*)$/)?.[1].trim()
    if (!text) break
    lines.push(text)
  }
  return lines
}

/** Exactly one trailing period, whether or not the source line had one. */
function sentence(text: string): string {
  return `${text.replace(/[.\s]+$/, "")}.`
}

/** A copy-ready brief for a coding agent: what the jig does, when it runs, what it connects to. */
function buildPrompt(example: Omit<ExampleJig, "prompt">, uses: string | undefined): string {
  const parts = [`Create a jig "${example.id}": ${sentence(example.description)}`]
  if (uses) parts.push(sentence(uses))
  parts.push(`Trigger: ${example.trigger}.`)
  if (example.connections.length > 0) parts.push(`Connections: ${example.connections.join(", ")}.`)
  return parts.join(" ")
}

export function listExampleJigs(): ExampleJig[] {
  if (!existsSync(EXAMPLES_DIR)) return []

  return readdirSync(EXAMPLES_DIR)
    .filter((name) => name.endsWith(".ts") && !name.startsWith("_"))
    .map((name) => name.replace(/\.ts$/, ""))
    .sort()
    .map((id) => {
      const filePath = `${EXAMPLES_DIR}/${id}.ts`
      const code = readFileSync(filePath, "utf-8")
      const name = prettifyId(id)
      const example = {
        id,
        name,
        trigger: extractTrigger(code) || "Manual",
        description: extractDescription(code, `${name} example jig.`),
        connections: extractConnections(code),
      }
      return { ...example, prompt: buildPrompt(example, headerComments(code)[1]) }
    })
}

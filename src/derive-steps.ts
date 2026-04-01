/**
 * Derive human-readable steps for a jig.
 *
 * 1. scanSteps() runs the handler in stub mode → raw labels + connections
 * 2. LLM polishes raw labels into human-readable names
 * 3. Result cached by code hash — only re-derives when code changes
 */
import type { JigDefinition } from "./sdk/jig.js"
import type { CachedStep } from "./db.js"
import { HUMANIZE_MODEL } from "./config/models.js"

const TOOL_LABELS: Record<string, string> = {
  gmail: "Gmail",
  calendar: "Calendar",
  drive: "Drive",
  github: "GitHub",
  granola: "Granola",
  slack: "Slack",
  notion: "Notion",
}

const VERB_LABELS: Record<string, string> = {
  search: "Search",
  get: "Read",
  read: "Read",
  list: "List",
  create: "Create",
  draft: "Create",
  send: "Send",
  write: "Write",
  update: "Update",
  sync: "Sync",
  summarize: "Summarize",
  analyze: "Analyze",
  query: "Query",
}

function prettifyToken(value: string): string {
  const normalized = value.toLowerCase()
  if (TOOL_LABELS[normalized]) return TOOL_LABELS[normalized]
  return normalized.replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())
}

function isRawToolLabel(name: string): boolean {
  const value = name.trim()
  return /^[a-z0-9_]+\.[a-z0-9_]+$/.test(value) || /^[a-z0-9_]+__[a-z0-9_]+$/.test(value)
}

export function isHumanizedStepName(name: string): boolean {
  const value = name.trim()
  return value.length > 0 && value.length <= 60 && !isRawToolLabel(value)
}

export function isUsableCachedSteps(steps: CachedStep[]): boolean {
  return steps.every((step) =>
    isHumanizedStepName(step.name) &&
    (!(step.connections?.length) || (step.tools?.length ?? 0) > 0)
  )
}

function fallbackStepName(step: {
  label: string
  tools: { connection: string; name: string; readOnly: boolean }[]
}): string {
  if (step.tools.length === 1) {
    const tool = step.tools[0]
    const parts = tool.name.split("_").filter(Boolean)
    const last = parts.at(-1)?.toLowerCase() ?? ""
    const first = parts[0]?.toLowerCase() ?? ""
    const verb = VERB_LABELS[last]

    if (verb && first && first !== last) {
      return `${verb} ${prettifyToken(first)}`
    }

    return prettifyToken(tool.name)
  }

  if (step.tools.length > 1) {
    const services = [...new Set(step.tools.map((tool) => tool.name.split("_")[0]).filter(Boolean))]
    if (services.length === 1) {
      return `Review ${prettifyToken(services[0])} data`
    }
    return "Review connected data"
  }

  return prettifyToken(step.label.replace(/^[^.]+\./, ""))
}

export async function deriveSteps(
  def: JigDefinition,
  jigId: string,
  code: string,
): Promise<CachedStep[]> {
  const { getStepCache, setStepCache } = await import("./db.js")

  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(code)
  const codeHash = hasher.digest("hex")

  // Check cache — reject if any label looks unhumanized (raw prompt text)
  const cached = getStepCache(jigId, codeHash)
  if (cached && isUsableCachedSteps(cached)) return cached

  // Scan handler for raw steps
  const { scanSteps } = await import("./sdk/jig.js")
  const raw = await scanSteps(def)
  if (raw.length === 0) return []

  // Humanize via LLM (retry once on failure)
  let steps: CachedStep[]
  let humanized = false
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      steps = await humanizeLabels(raw)
      humanized = true
      break
    } catch (e) {
      console.warn(`Step humanization attempt ${attempt + 1} failed:`, (e as Error)?.message)
      if (attempt === 0) await new Promise(r => setTimeout(r, 500))
    }
  }
  // Fallback: use raw labels — don't cache so next request retries
  if (!humanized) {
    steps = raw.map(s => ({ num: s.seq, name: fallbackStepName(s), connections: s.connections, tools: s.tools }))
    return steps
  }

  // Only cache successfully humanized steps
  try { setStepCache(jigId, codeHash, steps!) } catch {}

  return steps!
}

async function humanizeLabels(
  raw: { seq: number; label: string; connections: string[]; tools: { connection: string; name: string; readOnly: boolean }[] }[]
): Promise<CachedStep[]> {
  const { getClient } = await import("./sdk/llm.js")
  const client = getClient()

  const input = raw.map(s => `${s.seq}. ${s.label} [${s.connections.join(", ")}]`).join("\n")

  const response = await client.chat.completions.create({
    model: HUMANIZE_MODEL,
    max_tokens: 4096,
    messages: [{ role: "user", content: `Rewrite these automation step labels as short, human-readable action titles. Max 32 characters each, 2-5 words. Keep the same order and count. Return JSON array of strings only.

${input}` }],
    response_format: {
      type: "json_schema",
      json_schema: {
        name: "step_names",
        strict: true,
        schema: {
          type: "object",
          properties: {
            names: { type: "array", items: { type: "string" } },
          },
          required: ["names"],
          additionalProperties: false,
        },
      },
    },
  })

  const text = response.choices[0]?.message?.content?.trim()
  if (!text) throw new Error("LLM returned empty response")
  const parsed = JSON.parse(text.replace(/^```json?\s*|\s*```$/g, ""))
  const names: string[] = Array.isArray(parsed) ? parsed : (parsed.names ?? [])

  return raw.map((s, i) => ({
    num: s.seq,
    name: isHumanizedStepName(names[i] ?? "") ? names[i]! : fallbackStepName(s),
    connections: s.connections,
    tools: s.tools,
  }))
}

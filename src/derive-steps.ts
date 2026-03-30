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

export async function deriveSteps(
  def: JigDefinition,
  jigId: string,
  entity: string | null,
  code: string,
): Promise<CachedStep[]> {
  const { getStepCache, setStepCache } = await import("./db.js")

  const hasher = new Bun.CryptoHasher("sha256")
  hasher.update(code)
  const codeHash = hasher.digest("hex")

  // Check cache — reject if any label looks unhumanized (raw prompt text)
  const cached = getStepCache(jigId, entity, codeHash)
  if (cached && cached.every(s => s.name.length <= 60)) return cached

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
    steps = raw.map(s => ({ num: s.seq, name: s.label, connections: s.connections }))
    return steps
  }

  // Only cache successfully humanized steps
  try { setStepCache(jigId, entity, codeHash, steps!) } catch {}

  return steps!
}

async function humanizeLabels(
  raw: { seq: number; label: string; connections: string[] }[]
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
    name: names[i] ?? s.label,
    connections: s.connections,
  }))
}

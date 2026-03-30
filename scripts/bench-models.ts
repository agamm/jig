/**
 * Benchmark cheap OpenRouter models for latency + accuracy with tool use.
 * Usage: bun scripts/bench-models.ts
 */

const MODELS = [
  // Winners from round 1
  "mistralai/mistral-nemo",
  "meta-llama/llama-3.3-70b-instruct",
  "google/gemini-2.0-flash-lite-001",
  "google/gemini-2.0-flash-001",
  // Newer models
  "google/gemini-2.5-flash",
  "qwen/qwen3.5-flash-02-23",
  "qwen/qwen3.5-35b-a3b",
  "qwen/qwen3.5-122b-a10b",
  "qwen/qwen3-coder-flash",
  "qwen/qwen3-next-80b-a3b-instruct",
  "stepfun/step-3.5-flash:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
]

const API_KEY = process.env.OPENROUTER_API_KEY
if (!API_KEY) { console.error("OPENROUTER_API_KEY not set"); process.exit(1) }

const TOOL_DEF = {
  type: "function" as const,
  function: {
    name: "gmail_search",
    description: "Search Gmail messages",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        maxResults: { type: "number", description: "Max results to return" },
      },
      required: ["query"],
    },
  },
}

const PROMPT = `Search Gmail for emails from "billing@acme.co" about invoices from last week. Return max 5 results.`

const STRUCT_PROMPT = `Given this data: { "hours": 40, "rate": 150, "client": "Acme Corp" }, calculate the invoice total and return as JSON with keys: total (number), client (string), description (string).`

async function callModel(model: string, messages: any[], tools?: any[], responseFormat?: any) {
  const body: any = { model, max_tokens: 1024, messages }
  if (tools) body.tools = tools
  if (responseFormat) body.response_format = responseFormat

  const start = Date.now()
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  })
  const latency = Date.now() - start
  const data = await res.json() as any

  if (data.error) return { latency, error: data.error.message ?? JSON.stringify(data.error) }
  return { latency, data }
}

interface Result {
  model: string
  toolLatency: number
  toolCorrect: boolean
  toolError?: string
  structLatency: number
  structCorrect: boolean
  structError?: string
}

async function benchModel(model: string): Promise<Result> {
  // Test 1: Tool use — should call gmail_search with correct query
  const t1 = await callModel(model, [{ role: "user", content: PROMPT }], [TOOL_DEF])
  let toolCorrect = false
  let toolError: string | undefined
  if (t1.error) {
    toolError = t1.error
  } else {
    const msg = t1.data?.choices?.[0]?.message
    const calls = msg?.tool_calls
    if (calls?.length > 0) {
      const call = calls[0]
      const args = typeof call.function.arguments === "string" ? JSON.parse(call.function.arguments) : call.function.arguments
      toolCorrect = call.function.name === "gmail_search" && typeof args.query === "string" && args.query.length > 0
      if (!toolCorrect) toolError = `wrong: ${call.function.name}(${JSON.stringify(args)})`
    } else {
      toolError = `no tool call, got: ${(msg?.content ?? "").slice(0, 80)}`
    }
  }

  // Test 2: Structured JSON output — should return correct calculation
  const t2 = await callModel(model, [{ role: "user", content: STRUCT_PROMPT }], undefined, {
    type: "json_schema",
    json_schema: {
      name: "invoice",
      strict: true,
      schema: {
        type: "object",
        properties: { total: { type: "number" }, client: { type: "string" }, description: { type: "string" } },
        required: ["total", "client", "description"],
        additionalProperties: false,
      },
    },
  })
  let structCorrect = false
  let structError: string | undefined
  if (t2.error) {
    structError = t2.error
  } else {
    const raw = t2.data?.choices?.[0]?.message?.content ?? ""
    try {
      // Strip backtick fences
      const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/)
      const text = fenced ? fenced[1].trim() : raw.trim()
      const parsed = JSON.parse(text)
      structCorrect = parsed.total === 6000 && parsed.client === "Acme Corp" && typeof parsed.description === "string"
      if (!structCorrect) structError = `wrong: total=${parsed.total} client=${parsed.client}`
    } catch (e: any) {
      structError = `parse fail: ${raw.slice(0, 80)}`
    }
  }

  return { model, toolLatency: t1.latency, toolCorrect, toolError, structLatency: t2.latency, structCorrect, structError }
}

console.log(`\nBenchmarking ${MODELS.length} models...\n`)

const results: Result[] = []
for (const model of MODELS) {
  process.stdout.write(`  ${model} ... `)
  const r = await benchModel(model)
  const toolIcon = r.toolCorrect ? "✓" : "✗"
  const structIcon = r.structCorrect ? "✓" : "✗"
  console.log(`${toolIcon} tools ${r.toolLatency}ms  ${structIcon} json ${r.structLatency}ms${r.toolError ? `  (${r.toolError})` : ""}${r.structError ? `  (${r.structError})` : ""}`)
  results.push(r)
}

// Summary table
console.log(`\n${"─".repeat(100)}`)
console.log(`${"Model".padEnd(45)} ${"Tools".padEnd(8)} ${"JSON".padEnd(8)} ${"T(ms)".padStart(7)} ${"J(ms)".padStart(7)}  Notes`)
console.log(`${"─".repeat(100)}`)
for (const r of results.sort((a, b) => (a.toolLatency + a.structLatency) - (b.toolLatency + b.structLatency))) {
  const toolIcon = r.toolCorrect ? " ✓" : " ✗"
  const structIcon = r.structCorrect ? " ✓" : " ✗"
  const notes = [r.toolError, r.structError].filter(Boolean).join("; ")
  console.log(`${r.model.padEnd(45)} ${toolIcon.padEnd(8)} ${structIcon.padEnd(8)} ${String(r.toolLatency).padStart(7)} ${String(r.structLatency).padStart(7)}  ${notes.slice(0, 50)}`)
}
console.log()

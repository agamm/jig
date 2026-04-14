import type { McpConnection } from "../client.js"
import { callTool } from "../client.js"
import { llm } from "../../sdk/llm.js"
import { firstLineSummary } from "../../text.js"

type ActorCard = {
  fullName: string
  title?: string
  description?: string
  url?: string
  categories?: string[]
  totalUsers?: number
  monthlyUsers?: number
  successRate?: number
  bookmarks?: number
  rating?: number
}

type ActorDetails = {
  actorInfo?: {
    fullName?: string
    title?: string
    description?: string
    categories?: string[]
    url?: string
  }
  description?: string
  inputSchema?: unknown
  outputSchema?: unknown
  totalUsers?: number
  monthlyUsers?: number
  successRate?: number
  bookmarks?: number
  rating?: number
}

type ApifyDiscoveryOps = {
  callTool: typeof callTool
  llm: typeof llm
}

export async function resolveForBuild(args: {
  description: string
  connection: McpConnection
  ask?: (question: string) => Promise<string>
}): Promise<{ context: string; requiredTools?: string[]; includeTools?: string[]; excludeTools?: string[]; resolvedTarget?: string; resolvedInputSchema?: unknown } | null> {
  return resolveForBuildWithOps(args, { callTool, llm })
}

export async function resolveForBuildWithOps(
  args: {
    description: string
    connection: McpConnection
    ask?: (question: string) => Promise<string>
  },
  ops: ApifyDiscoveryOps
): Promise<{ context: string; requiredTools?: string[]; includeTools?: string[]; excludeTools?: string[]; resolvedTarget?: string; resolvedInputSchema?: unknown } | null> {
  const explicitActor = findExplicitActorName(args.description)
  const candidates = explicitActor
    ? [{ fullName: explicitActor }]
    : sortCandidatesByPopularity(await searchCandidates(args.connection, args.description, ops))

  if (candidates.length === 0) return null

  const detailedCandidates = await loadCandidateDetails(args.connection, candidates.slice(0, 4), ops)
  if (detailedCandidates.length === 0) return null

  if (explicitActor || detailedCandidates.length === 1) {
    const chosen = detailedCandidates[0]
    return {
      context: buildResolutionContext(
        chosen,
        explicitActor ? "The user explicitly named this Apify Actor." : "This was the only strong Apify Actor match found."
      ),
      requiredTools: ["call-actor"],
      includeTools: ["call-actor", "get-actor-run", "get-actor-output"],
      excludeTools: ["search-actors", "fetch-actor-details"],
      resolvedTarget: chosen.details.actorInfo?.fullName ?? chosen.fullName,
      resolvedInputSchema: chosen.details.inputSchema ?? null,
    }
  }

  const rankedCandidates = sortCandidatesByPopularity(detailedCandidates)
  const selection = await chooseActor(args.description, rankedCandidates, ops)
  let actorName = selection.actor

  if (selection.askUser && rankedCandidates.length > 1 && args.ask) {
    const answer = await args.ask(buildChoiceQuestion(rankedCandidates))
    actorName = await resolveUserChoice(answer, rankedCandidates, actorName, ops)
  }

  const chosen = rankedCandidates.find((candidate) => candidate.fullName === actorName) ?? rankedCandidates[0]
  return {
    context: buildResolutionContext(chosen, selection.reason),
    requiredTools: ["call-actor"],
    includeTools: ["call-actor", "get-actor-run", "get-actor-output"],
    excludeTools: ["search-actors", "fetch-actor-details"],
    resolvedTarget: chosen.details.actorInfo?.fullName ?? chosen.fullName,
    resolvedInputSchema: chosen.details.inputSchema ?? null,
  }
}

function findExplicitActorName(description: string): string | null {
  const urlMatch = description.match(/https?:\/\/apify\.com\/([a-z0-9-]+\/[a-z0-9-][a-z0-9-./]*)/i)
  if (urlMatch) return urlMatch[1]

  const namedMatch = description.match(/\b(?:actor|use|using)\s+([a-z0-9-]+\/[a-z0-9-][a-z0-9-./]*)\b/i)
  return namedMatch?.[1] ?? null
}

async function searchCandidates(
  connection: McpConnection,
  description: string,
  ops: ApifyDiscoveryOps
): Promise<ActorCard[]> {
  const query = await deriveQuery(description, ops)
  const byName = new Map<string, ActorCard>()

  if (!query) return []

  const result = await ops.callTool(connection, "search-actors", { keywords: query, limit: 5 }) as any
  for (const actor of await normalizeActorCards(result, ops)) {
    if (!actor.fullName || byName.has(actor.fullName)) continue
    byName.set(actor.fullName, actor)
  }

  return [...byName.values()]
}

async function deriveQuery(description: string, ops: ApifyDiscoveryOps): Promise<string> {
  const result = await ops.llm<{ query: string }>(
    `Choose one short Apify Store search query to find the best Actor for this automation.

Rules:
- Return exactly 1 query
- The query must be 1-3 words
- Use platform/use-case keywords, not full sentences
- Prefer broad-but-specific terms like "github trending", "google maps", "real estate leads"
- Do not include punctuation or quotes`,
    { description },
    { schema: { query: "string" } }
  )

  return String(result.query ?? "").trim()
}

async function normalizeActorCards(result: any, ops: ApifyDiscoveryOps): Promise<ActorCard[]> {
  const markdown = toMarkdownText(result)
  if (markdown) return parseActorCardsFromMarkdown(markdown, ops)
  const actors = Array.isArray(result?.actors) ? result.actors : []
  return actors
    .map((actor: any) => normalizeActorCard(actor))
    .filter((actor: ActorCard) => Boolean(actor.fullName))
}

async function loadCandidateDetails(
  connection: McpConnection,
  candidates: ActorCard[],
  ops: ApifyDiscoveryOps
): Promise<Array<ActorCard & { details: ActorDetails }>> {
  const resolved = await Promise.all(
    candidates.map(async (candidate) => {
      try {
        const raw = await ops.callTool(connection, "fetch-actor-details", {
          actor: candidate.fullName,
          output: {
            description: true,
            inputSchema: true,
            outputSchema: true,
            metadata: true,
            stats: true,
            rating: true,
          },
        })
        const details = await normalizeActorDetails(raw, candidate, ops)
        return { ...candidate, details }
      } catch {
        return null
      }
    })
  )

  return resolved.filter(Boolean) as Array<ActorCard & { details: ActorDetails }>
}

async function chooseActor(
  description: string,
  candidates: Array<ActorCard & { details: ActorDetails }>,
  ops: ApifyDiscoveryOps
): Promise<{ actor: string; reason: string; askUser: boolean }> {
  const shortlist = candidates.map((candidate) => ({
    actor: candidate.fullName,
    title: candidate.details.actorInfo?.title ?? candidate.title ?? candidate.fullName,
    description: firstLineSummary(candidate.details.description ?? candidate.details.actorInfo?.description ?? candidate.description),
    categories: candidate.details.actorInfo?.categories ?? candidate.categories ?? [],
    popularity: {
      monthlyUsers: candidate.details.monthlyUsers ?? candidate.monthlyUsers ?? null,
      totalUsers: candidate.details.totalUsers ?? candidate.totalUsers ?? null,
      successRate: candidate.details.successRate ?? candidate.successRate ?? null,
      bookmarks: candidate.details.bookmarks ?? candidate.bookmarks ?? null,
      rating: candidate.details.rating ?? candidate.rating ?? null,
    },
    inputSchema: candidate.details.inputSchema ?? null,
  }))

  return await ops.llm<{ actor: string; reason: string; askUser: boolean }>(
    `Choose the best Apify Actor for implementing this automation at build time.

Rules:
- Prefer a concrete Actor that directly solves the requested workflow
- Prefer stable, reusable scrapers over generic search/browser tools
- When multiple Actors fit semantically, prefer the one with stronger adoption and reliability signals (monthly users, total users, bookmarks, success rate, rating)
- Set askUser=true only if two or more candidates are genuinely plausible and the tradeoff is product-level, not minor
- Return the chosen actor full name exactly as provided in the shortlist`,
    { description, candidates: shortlist },
    { schema: { actor: "string", reason: "string", askUser: "boolean" } }
  )
}

function buildChoiceQuestion(candidates: Array<ActorCard & { details: ActorDetails }>): string {
  const options = candidates
    .slice(0, 3)
    .map((candidate, index) => {
      const title = candidate.details.actorInfo?.title ?? candidate.title ?? candidate.fullName
      const summary = firstLineSummary(candidate.details.description ?? candidate.details.actorInfo?.description ?? candidate.description)
      return `${index + 1}. ${candidate.fullName} — ${title}${summary ? `: ${summary}` : ""}`
    })
    .join("\n")

  return `Which Apify Actor should this jig use?\n${options}\nReply with the number or the actor name.`
}

async function resolveUserChoice(
  answer: string,
  candidates: Array<ActorCard & { details: ActorDetails }>,
  fallbackActor: string,
  ops: ApifyDiscoveryOps
): Promise<string> {
  const trimmed = answer.trim()
  if (!trimmed) return fallbackActor

  const numeric = Number.parseInt(trimmed, 10)
  if (Number.isInteger(numeric) && numeric >= 1 && numeric <= candidates.length) {
    return candidates[numeric - 1].fullName
  }

  const normalizedAnswer = normalizeChoiceText(trimmed)
  const direct = candidates.find((candidate) => {
    const normalizedFullName = normalizeChoiceText(candidate.fullName)
    const normalizedTitle = normalizeChoiceText(candidate.details.actorInfo?.title ?? candidate.title ?? "")
    return normalizedAnswer === normalizedFullName || normalizedAnswer === normalizedTitle
  })
  if (direct) return direct.fullName

  const result = await ops.llm<{ actor: string }>(
    `Map the user's answer to one of the available Apify Actors.
Return the actor full name exactly as listed.`,
    {
      answer,
      candidates: candidates.map((candidate) => ({
        actor: candidate.fullName,
        title: candidate.details.actorInfo?.title ?? candidate.title ?? candidate.fullName,
      })),
      fallbackActor,
    },
    { schema: { actor: "string" } }
  )

  return candidates.find((candidate) => candidate.fullName === result.actor)?.fullName ?? fallbackActor
}

function normalizeChoiceText(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
}

function buildResolutionContext(candidate: ActorCard & { details: ActorDetails }, reason: string): string {
  const actorInfo = candidate.details.actorInfo
  const actorName = actorInfo?.fullName ?? candidate.fullName
  const title = actorInfo?.title ?? candidate.title ?? actorName
  const summary = firstLineSummary(candidate.details.description ?? actorInfo?.description ?? candidate.description)
  const inputSchema = candidate.details.inputSchema ?? {}
  const outputSchema = candidate.details.outputSchema

  const parts = [
    `Resolved Apify Actor at build time for this workflow: ${actorName}.`,
    `Tool contract: call \`apify.call_actor({ actor: "${actorName}", input: { ... } })\`. Use \`actor\`, not \`actorId\`, and pass a real object to \`input\`, not a JSON string. When the response includes \`datasetId\`, call \`apify.get_actor_output({ datasetId })\`. Important: \`apify.get_actor_output\` returns an object like \`{ datasetId, items, itemCount, totalItemCount }\`, not the items array directly. Read \`const output = await apify.get_actor_output(...)\` and then \`const items = output.items ?? []\`. If the second tool depends on the first tool's result, prefer a second \`ctx.step(...)\` for \`apify.get_actor_output\` rather than calling both tools inside one step. Do not call \`apify.get_actor_run\` immediately after a normal sync \`apify.call_actor\` just to recover output. Do not use \`apify.search_actors\` or \`apify.fetch_actor_details\` in the jig runtime unless the user explicitly wants dynamic rediscovery.`,
    `Selection note: ${reason}`,
    summary ? `Actor summary: ${title} — ${summary}` : `Actor summary: ${title}`,
    `Relevant actor input fields:\n${summarizeInputSchema(inputSchema)}`,
  ]

  if (outputSchema) {
    parts.push(`Relevant actor output fields:\n${summarizeOutputSchema(outputSchema)}`)
  }

  return parts.join("\n\n")
}

function summarizeInputSchema(schema: unknown): string {
  const properties = getSchemaProperties(schema)
  if (properties.length === 0) return "- No structured input schema was provided."

  const required = new Set(Array.isArray((schema as any)?.required) ? (schema as any).required : [])
  const ordered = [
    ...properties.filter(([name]) => required.has(name)),
    ...properties.filter(([name]) => !required.has(name)),
  ]

  return ordered.slice(0, 8).map(([name, value]) => {
    const parts = [`- ${name}: ${summarizeSchemaValue(value)}`]
    const description = firstLineSummary(getSchemaDescription(value))
    if (description) parts.push(` — ${description}`)
    return parts.join("")
  }).join("\n")
}

function summarizeOutputSchema(schema: unknown): string {
  const properties = prioritizeOutputFields(getSchemaProperties(schema))
  if (properties.length === 0) return "- No structured output schema was provided."

  return properties.slice(0, 10).map(([name, value]) => {
    const description = firstLineSummary(getSchemaDescription(value))
    return `- ${name}: ${summarizeSchemaValue(value)}${description ? ` — ${description}` : ""}`
  }).join("\n")
}

function getSchemaProperties(schema: unknown): Array<[string, any]> {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return []
  const record = schema as Record<string, any>
  if (record.properties && typeof record.properties === "object" && !Array.isArray(record.properties)) {
    return Object.entries(record.properties)
  }
  return Object.entries(record)
}

function summarizeSchemaValue(value: any): string {
  if (Array.isArray(value?.enum) && value.enum.length > 0) {
    return value.enum.map((entry: unknown) => JSON.stringify(entry)).join(" | ")
  }
  if (typeof value === "string") return value
  if (Array.isArray(value)) {
    if (value.length === 0) return "array"
    return `array<${summarizeSchemaValue(value[0])}>`
  }
  if (value && typeof value === "object") {
    if (typeof value.type === "string") return value.type
    if (value.items) return `array<${summarizeSchemaValue(value.items)}>`
    return "object"
  }
  return "unknown"
}

function getSchemaDescription(value: any): string {
  return typeof value?.description === "string" ? value.description : ""
}

function prioritizeOutputFields(properties: Array<[string, any]>): Array<[string, any]> {
  const priority = ["items", "datasetId", "itemCount", "totalItemCount", "rank", "fullName", "name", "description", "language", "stars", "starsToday", "forks", "url"]
  const rank = new Map(priority.map((field, index) => [field, index]))
  return [...properties].sort(([a], [b]) => {
    const aRank = rank.get(a) ?? Number.MAX_SAFE_INTEGER
    const bRank = rank.get(b) ?? Number.MAX_SAFE_INTEGER
    if (aRank !== bRank) return aRank - bRank
    return a.localeCompare(b)
  })
}

async function parseActorCardsFromMarkdown(markdown: string, ops: ApifyDiscoveryOps): Promise<ActorCard[]> {
  const result = await ops.llm<{ actors: ActorCard[] }>(
    `Extract structured Apify Actor search results from markdown.

Rules:
- Return only actors explicitly listed in the markdown
- Preserve actor full names exactly
- Extract popularity signals when present: totalUsers, monthlyUsers, successRate, bookmarks, rating
- Omit fields that are not present
- Return JSON only`,
    { markdown },
    { schema: { actors: "array" } }
  )

  return (result.actors ?? [])
    .map((actor) => normalizeActorCard(actor))
    .filter((actor) => Boolean(actor.fullName))
}

function normalizeActorCard(actor: Record<string, any>): ActorCard {
  return {
    fullName: String(actor.fullName ?? actor.actorId ?? actor.id ?? "").trim(),
    title: actor.title ?? actor.name,
    description: actor.description,
    url: actor.url,
    categories: Array.isArray(actor.categories)
      ? actor.categories
      : typeof actor.categories === "string"
        ? actor.categories.split(",").map((value: string) => value.trim()).filter(Boolean)
        : [],
    totalUsers: toOptionalNumber(actor.totalUsers ?? actor.stats?.totalUsers),
    monthlyUsers: toOptionalNumber(actor.monthlyUsers ?? actor.stats?.monthlyUsers),
    successRate: toOptionalNumber(actor.successRate ?? actor.stats?.successRate),
    bookmarks: toOptionalNumber(actor.bookmarks ?? actor.stats?.bookmarks),
    rating: toOptionalNumber(actor.rating?.value ?? actor.rating),
  }
}

async function normalizeActorDetails(result: unknown, fallback: ActorCard, ops: ApifyDiscoveryOps): Promise<ActorDetails> {
  const markdown = toMarkdownText(result)
  if (markdown) {
    return parseActorDetailsFromMarkdown(markdown, fallback, ops)
  }

  if (result && typeof result === "object" && !Array.isArray(result)) {
    return result as ActorDetails
  }
  if (typeof result !== "string") {
    return {
      actorInfo: {
        fullName: fallback.fullName,
        title: fallback.title,
        description: fallback.description,
        categories: fallback.categories,
        url: fallback.url,
      },
      totalUsers: fallback.totalUsers,
      monthlyUsers: fallback.monthlyUsers,
      successRate: fallback.successRate,
      bookmarks: fallback.bookmarks,
      rating: fallback.rating,
    }
  }

  return {
    actorInfo: {
      fullName: fallback.fullName,
      title: fallback.title,
      description: fallback.description,
      categories: fallback.categories,
      url: fallback.url,
    },
    totalUsers: fallback.totalUsers,
    monthlyUsers: fallback.monthlyUsers,
    successRate: fallback.successRate,
    bookmarks: fallback.bookmarks,
    rating: fallback.rating,
  }
}

async function parseActorDetailsFromMarkdown(
  markdown: string,
  fallback: ActorCard,
  ops: ApifyDiscoveryOps
): Promise<ActorDetails> {
  const result = await ops.llm<{
    actorInfo?: ActorDetails["actorInfo"]
    description?: string
    inputSchema?: unknown
    outputSchema?: unknown
    totalUsers?: number | string
    monthlyUsers?: number | string
    successRate?: number | string
    bookmarks?: number | string
    rating?: number | string
  }>(
    `Extract structured Apify Actor details from markdown.

Rules:
- Preserve the actor full name exactly
- Extract actorInfo, description, inputSchema, and outputSchema when present
- Extract popularity signals when present: totalUsers, monthlyUsers, successRate, bookmarks, rating
- Omit fields that are not present
- Return JSON only`,
    { markdown },
    {
      schema: {
        actorInfo: "object",
        description: "string",
        inputSchema: "object",
        outputSchema: "object",
        totalUsers: "number",
        monthlyUsers: "number",
        successRate: "number",
        bookmarks: "number",
        rating: "number",
      } as any,
    }
  )

  return {
    actorInfo: {
      fullName: result.actorInfo?.fullName ?? fallback.fullName,
      title: result.actorInfo?.title ?? fallback.title,
      description: result.actorInfo?.description ?? result.description ?? fallback.description,
      categories: result.actorInfo?.categories ?? fallback.categories,
      url: result.actorInfo?.url ?? fallback.url,
    },
    description: result.description ?? result.actorInfo?.description ?? fallback.description,
    inputSchema: result.inputSchema,
    outputSchema: result.outputSchema,
    totalUsers: toOptionalNumber(result.totalUsers) ?? fallback.totalUsers,
    monthlyUsers: toOptionalNumber(result.monthlyUsers) ?? fallback.monthlyUsers,
    successRate: toOptionalNumber(result.successRate) ?? fallback.successRate,
    bookmarks: toOptionalNumber(result.bookmarks) ?? fallback.bookmarks,
    rating: toOptionalNumber(result.rating) ?? fallback.rating,
  }
}

function toMarkdownText(result: unknown): string | null {
  if (typeof result === "string") return result
  if (Array.isArray(result) && result.every((item) => typeof item === "string")) {
    return result.join("\n")
  }
  return null
}

function sortCandidatesByPopularity<T extends ActorCard>(candidates: T[]): T[] {
  return [...candidates].sort((a, b) =>
    compareNumbers(b.monthlyUsers, a.monthlyUsers)
    || compareNumbers(b.bookmarks, a.bookmarks)
    || compareNumbers(b.rating, a.rating)
    || compareNumbers(b.totalUsers, a.totalUsers)
    || compareNumbers(b.successRate, a.successRate)
  )
}

function compareNumbers(a?: number, b?: number): number {
  return (a ?? -1) - (b ?? -1)
}

function toOptionalNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "string") return undefined
  const normalized = value.replace(/,/g, "")
  const parsed = Number.parseFloat(normalized)
  return Number.isFinite(parsed) ? parsed : undefined
}

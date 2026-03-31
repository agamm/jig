import { existsSync, readFileSync, readdirSync } from "fs"
import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import type { AgentEvent, AgentStatusResponseDto, StartAgentResponseDto } from "../../shared/api.js"
import { JIGS_DIR, PROJECT_ROOT, SCHEMAS_DIR, TYPES_DIR } from "../config/paths.js"
import { JIG_EDITOR_MODEL } from "../config/models.js"
import { isValidJigId } from "../domain/jig-id.js"
import { loadServerConfigs } from "../mcp/config.js"
import { resolveJigPath } from "../domain/jig-source.js"
import { checkJigFile } from "./jig-checker.js"
import { buildAgentJigSystemPrompt } from "./jig-writing-prompt.js"
import { writeJigSource } from "./jig-writer.js"
import { ApiError } from "../server/http.js"

const MAX_AGENT_ROUNDS = 15
const AGENT_SESSION_TTL = 30 * 60 * 1000

type AgentSession = {
  sessionId: string
  jigId?: string
  entity?: string
  messages: ChatCompletionMessageParam[]
  events: AgentEvent[]
  status: "thinking" | "tool-calling" | "waiting" | "done" | "error"
  createdAt: number
}

const agentSessions = new Map<string, AgentSession>()
const activeAgentJigs = new Set<string>()

function hasCompletedTool(session: AgentSession, tool: string): boolean {
  return session.events.some((event) =>
    event.type === "tool-call" && event.tool === tool && event.status === "done"
  )
}

function pruneAgentSessions() {
  const now = Date.now()
  for (const [id, session] of agentSessions) {
    if (now - session.createdAt > AGENT_SESSION_TTL) {
      if (session.jigId) activeAgentJigs.delete(session.jigId)
      agentSessions.delete(id)
    }
  }
}

function getAgentClient(): OpenAI {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new ApiError(500, "OPENROUTER_API_KEY not set")
  return new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey })
}

const AGENT_TOOL_DEFS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "read_jig_file",
      description: "Read the current source code of a jig file. Defaults to the session's jig if no jigId given.",
      parameters: {
        type: "object",
        properties: {
          jigId: { type: "string", description: "Jig ID to read (optional, defaults to session jig)" },
          entity: { type: "string", description: "Entity name for grouped jigs" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_jig_file",
      description: "Write full TypeScript source code to a jig file. Auto-commits to version control.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The complete TypeScript source code" },
          jigId: { type: "string", description: "Jig ID (required for creation, optional for editing)" },
          entity: { type: "string", description: "Entity name for grouped jigs" },
          message: { type: "string", description: "Short description of the change for the commit message" },
        },
        required: ["code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_jig",
      description: "Run TypeScript compiler and jig validator on the current jig file. Returns errors or 'ok'.",
      parameters: {
        type: "object",
        properties: {
          jigId: { type: "string", description: "Jig ID to check (optional, defaults to session jig)" },
          entity: { type: "string", description: "Entity name for grouped jigs" },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse",
      description: "Navigate to a URL and return the page content as text. Use for reading docs, API references, etc.",
      parameters: {
        type: "object",
        properties: {
          url: { type: "string", description: "The URL to navigate to" },
        },
        required: ["url"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description: "Search the web and return results. Use for finding API docs, examples, MCP tool schemas, etc.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
]

async function toolReadJigFile(args: { jigId?: string; entity?: string }, session: AgentSession): Promise<string> {
  const jigId = session.jigId ?? args.jigId
  if (!jigId) return JSON.stringify({ error: "No jigId specified and no session jig" })
  const entity = session.entity ?? args.entity
  const filePath = resolveJigPath(jigId, entity)
  if (!existsSync(filePath)) return JSON.stringify({ error: `File not found: ${filePath}` })
  return readFileSync(filePath, "utf-8")
}

async function toolWriteJigFile(args: { code: string; jigId?: string; entity?: string; message?: string }, session: AgentSession): Promise<string> {
  const jigId = session.jigId ?? args.jigId
  if (!jigId) return JSON.stringify({ error: "No jigId specified — provide jigId for new jigs" })
  if (!isValidJigId(jigId)) return JSON.stringify({ error: "Invalid jigId. Use lowercase letters, numbers, dashes, or underscores." })

  if (!session.jigId) {
    if (activeAgentJigs.has(jigId)) return JSON.stringify({ error: "Another session is already editing this jig" })
    session.jigId = jigId
    activeAgentJigs.add(jigId)
  }

  const entity = session.entity ?? args.entity
  if (entity && !isValidJigId(entity)) return JSON.stringify({ error: "Invalid entity. Use lowercase letters, numbers, dashes, or underscores." })
  const filePath = resolveJigPath(jigId, entity)
  await writeJigSource(filePath, args.code, {
    jigId,
    entity: entity ?? null,
    commit: true,
    commitMessage: args.message ? `jig: ${jigId} — ${args.message}` : `jig: ${jigId} — update`,
  })

  return JSON.stringify({ ok: true, path: filePath })
}

async function toolCheckJig(args: { jigId?: string; entity?: string }, session: AgentSession): Promise<string> {
  const jigId = session.jigId ?? args.jigId
  if (!jigId) return JSON.stringify({ error: "No jigId specified" })
  const entity = session.entity ?? args.entity
  const filePath = resolveJigPath(jigId, entity)
  if (!existsSync(filePath)) return JSON.stringify({ error: `File not found: ${filePath}` })
  return checkJigFile(filePath)
}

async function toolBrowse(args: { url: string }): Promise<string> {
  try {
    const proc = Bun.spawn(
      ["npx", "agent-browser", "--engine", "chromium", "--headless", "open", args.url],
      { stdout: "pipe", stderr: "pipe", timeout: 30_000 }
    )
    await proc.exited

    const snap = Bun.spawn(
      ["npx", "agent-browser", "snapshot"],
      { stdout: "pipe", stderr: "pipe", timeout: 15_000 }
    )
    const text = await new Response(snap.stdout).text()
    await snap.exited
    return text.slice(0, 50_000) || "(empty page)"
  } catch (e: any) {
    return JSON.stringify({ error: `Browse failed: ${e?.message}` })
  }
}

async function toolWebSearch(args: { query: string }): Promise<string> {
  return toolBrowse({ url: `https://www.google.com/search?q=${encodeURIComponent(args.query)}` })
}

async function executeAgentTool(name: string, args: Record<string, any>, session: AgentSession): Promise<string> {
  switch (name) {
    case "read_jig_file": return toolReadJigFile(args, session)
    case "write_jig_file": return toolWriteJigFile(args as any, session)
    case "check_jig": return toolCheckJig(args, session)
    case "browse": return toolBrowse(args as any)
    case "web_search": return toolWebSearch(args as any)
    default: return JSON.stringify({ error: `Unknown tool: ${name}` })
  }
}

async function buildAgentSystemPrompt(jigId?: string, entity?: string): Promise<string> {
  const skillPath = `${PROJECT_ROOT}/SKILL.md`
  const skillMd = existsSync(skillPath) ? readFileSync(skillPath, "utf-8") : ""

  const typeFiles = existsSync(TYPES_DIR) ? readdirSync(TYPES_DIR).filter((f) => f.endsWith(".d.ts")) : []
  const typeSections: string[] = []
  for (const file of typeFiles) {
    typeSections.push(`## Type: ${file}\n${readFileSync(`${TYPES_DIR}/${file}`, "utf-8")}`)
  }

  const schemaFiles = existsSync(SCHEMAS_DIR) ? readdirSync(SCHEMAS_DIR).filter((f) => f.endsWith(".json")) : []
  const toolCatalogSections: string[] = []
  for (const file of schemaFiles) {
    const serverName = file.replace(".json", "")
    const schemas = JSON.parse(readFileSync(`${SCHEMAS_DIR}/${file}`, "utf-8"))
    toolCatalogSections.push(`## ${serverName} tools\n${schemas.map((t: any) => `  ${t.name}: ${t.description?.split("\n")[0] ?? ""}`).join("\n")}`)
  }

  let serverDescriptions = ""
  try {
    const configs = await loadServerConfigs()
    serverDescriptions = Object.entries(configs).map(([name, cfg]) => `${name}: ${(cfg as any).description ?? ""}`).join("\n")
  } catch {}

  let currentCode: string | undefined
  if (jigId) {
    const filePath = resolveJigPath(jigId, entity)
    if (existsSync(filePath)) {
      currentCode = readFileSync(filePath, "utf-8")
    }
  }

  const examplePath = `${JIGS_DIR}/weekly-update.ts`
  const exampleJig = existsSync(examplePath) ? readFileSync(examplePath, "utf-8") : undefined

  return buildAgentJigSystemPrompt({
    jigId,
    entity,
    skillMd,
    typeDefs: typeSections.join("\n\n"),
    toolCatalog: toolCatalogSections.join("\n\n"),
    serverDescriptions,
    currentCode,
    exampleJig,
  })
}

async function runAgentLoop(session: AgentSession): Promise<void> {
  const client = getAgentClient()

  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    session.status = "thinking"

    const response = await client.chat.completions.create({
      model: JIG_EDITOR_MODEL,
      max_tokens: 16384,
      messages: session.messages,
      tools: AGENT_TOOL_DEFS,
    })

    const msg = response.choices[0]?.message
    if (!msg) {
      session.status = "error"
      return
    }

    session.messages.push(msg as ChatCompletionMessageParam)

    if (!msg.tool_calls?.length) {
      session.events.push({ type: "text", content: msg.content ?? "" })
      session.status = "done"
      return
    }

    session.status = "tool-calling"
    let roundHadToolError = false
    let roundHadSuccessfulCheck = false
    for (const toolCall of msg.tool_calls) {
      if (toolCall.type !== "function") {
        session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error: `Unsupported tool call type: ${toolCall.type}` }) })
        continue
      }
      let args: Record<string, any>
      try {
        args = JSON.parse(toolCall.function.arguments)
      } catch {
        session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error: "Invalid JSON in arguments" }) })
        continue
      }

      const event: AgentEvent = { type: "tool-call", tool: toolCall.function.name, args, status: "running" }
      session.events.push(event)

      try {
        const result = await executeAgentTool(toolCall.function.name, args, session)
        event.status = "done"
        event.result = result
        if (toolCall.function.name === "check_jig" && result === "ok") {
          roundHadSuccessfulCheck = true
        }
        session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: result })
      } catch (e: any) {
        event.status = "error"
        event.result = e?.message ?? String(e)
        roundHadToolError = true
        session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error: e?.message }) })
      }
    }

    if (!roundHadToolError && roundHadSuccessfulCheck && hasCompletedTool(session, "write_jig_file")) {
      session.events.push({
        type: "text",
        content: session.jigId
          ? `Updated ${session.jigId} and it passed the jig check.`
          : "Jig written and it passed the jig check.",
      })
      session.status = "done"
      return
    }
  }

  session.events.push({ type: "text", content: "Agent reached maximum rounds." })
  session.status = "done"
}

export async function startAgentSession(body: any): Promise<StartAgentResponseDto> {
  const instruction = body?.instruction as string
  if (!instruction) throw new ApiError(400, "instruction is required")

  const jigId = body?.jigId as string | undefined
  const entity = body?.entity as string | undefined

  if (jigId && !isValidJigId(jigId)) throw new ApiError(400, "Invalid jig ID")
  if (entity && !isValidJigId(entity)) throw new ApiError(400, "Invalid entity")
  if (jigId && activeAgentJigs.has(jigId)) {
    throw new ApiError(409, "An agent session is already editing this jig")
  }

  const sessionId = crypto.randomUUID()
  const systemPrompt = await buildAgentSystemPrompt(jigId, entity)

  const session: AgentSession = {
    sessionId,
    jigId,
    entity,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: instruction },
    ],
    events: [],
    status: "thinking",
    createdAt: Date.now(),
  }

  pruneAgentSessions()
  agentSessions.set(sessionId, session)
  if (jigId) activeAgentJigs.add(jigId)

  runAgentLoop(session).catch((error) => {
    session.status = "error"
    session.events.push({ type: "text", content: error?.message ?? String(error) })
  }).finally(() => {
    if (session.jigId) activeAgentJigs.delete(session.jigId)
  })

  return { sessionId, jigId }
}

export function getAgentSessionStatus(sessionId: string, sinceIndex: number): AgentStatusResponseDto {
  const session = agentSessions.get(sessionId)
  if (!session) throw new ApiError(404, "Session not found")

  return {
    status: session.status,
    jigId: session.jigId,
    events: session.events.slice(sinceIndex),
    totalEvents: session.events.length,
  }
}

export async function pushAgentMessage(sessionId: string, body: any): Promise<{ ok: true }> {
  const session = agentSessions.get(sessionId)
  if (!session) throw new ApiError(404, "Session not found")

  const message = body?.message as string
  if (!message) throw new ApiError(400, "message is required")

  session.messages.push({ role: "user", content: message })
  session.status = "thinking"

  runAgentLoop(session).catch((error) => {
    session.status = "error"
    session.events.push({ type: "text", content: error?.message ?? String(error) })
  })

  return { ok: true }
}

import { existsSync, readFileSync } from "fs"
import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import type { AgentEvent, AgentStatusResponse, StartAgentResponse } from "../../shared/api.js"
import { JIG_EDITOR_MODEL } from "../config/models.js"
import { isValidJigId } from "../domain/jig-id.js"
import { resolveJigPath } from "../domain/jig-source.js"
import { checkJigFile } from "./jig-checker.js"
import { buildAgentJigSystemPrompt } from "./jig-writing-prompt.js"
import { writeJigSource } from "./jig-writer.js"
import { ApiError } from "../server/http.js"
import {
  buildAuthoringState,
  collectBuildTimeToolPolicyIssues,
  hasExplicitEmptyToolsArray,
  type BuildTimeResolution,
} from "../jig-gen.js"

const MAX_AGENT_ROUNDS = 15
const AGENT_SESSION_TTL = 30 * 60 * 1000

type AgentSession = {
  sessionId: string
  jigId?: string
  authoringIntent: string
  authoringPolicy: {
    requiresIntegration: boolean
    buildResolutions: BuildTimeResolution[]
  }
  messages: ChatCompletionMessageParam[]
  events: AgentEvent[]
  status: "thinking" | "tool-calling" | "waiting" | "done" | "error"
  createdAt: number
  pendingAskToolCallId?: string
  pendingAskQuestion?: string
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

export function appendAuthoringIntent(current: string, next: string): string {
  const trimmedNext = next.trim()
  if (!trimmedNext) return current
  if (!current.trim()) return trimmedNext
  return `${current.trim()}\n\nFollow-up instruction:\n${trimmedNext}`
}

export function appendAskAnswer(authoringIntent: string, question: string | undefined, answer: string): string {
  const trimmedAnswer = answer.trim()
  if (!trimmedAnswer) return authoringIntent
  const detail = question?.trim()
    ? `User answer for authoring:\nQuestion: ${question.trim()}\nAnswer: ${trimmedAnswer}`
    : `User answer for authoring:\n${trimmedAnswer}`
  return appendAuthoringIntent(authoringIntent, detail)
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
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description: "Ask the user a question and wait for their response. Use this to collect information needed to write the jig — e.g. their email address, team name, Slack channel, or any other constant that should be hardcoded. The agent loop pauses until the user replies.",
      parameters: {
        type: "object",
        properties: {
          question: { type: "string", description: "A short, specific question for the user" },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "browse",
      description: "Navigate to a URL and return the page content as text. Use only for external docs or API references that are not already in the prompt context.",
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
      description: "Search the web and return results. Use only for external docs or examples that are not already in the prompt context.",
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

async function toolReadJigFile(args: { jigId?: string }, session: AgentSession): Promise<string> {
  const jigId = session.jigId ?? args.jigId
  if (!jigId) return JSON.stringify({ error: "No jigId specified and no session jig" })
  const filePath = resolveJigPath(jigId)
  if (!existsSync(filePath)) return JSON.stringify({ error: `File not found: ${filePath}` })
  return readFileSync(filePath, "utf-8")
}

async function toolWriteJigFile(args: { code: string; jigId?: string; message?: string }, session: AgentSession): Promise<string> {
  const jigId = session.jigId ?? args.jigId
  if (!jigId) return JSON.stringify({ error: "No jigId specified — provide jigId for new jigs" })
  if (!isValidJigId(jigId)) return JSON.stringify({ error: "Invalid jigId. Use lowercase letters, numbers, dashes, or underscores." })

  if (!session.jigId) {
    if (activeAgentJigs.has(jigId)) return JSON.stringify({ error: "Another session is already editing this jig" })
    session.jigId = jigId
    activeAgentJigs.add(jigId)
  }

  const filePath = resolveJigPath(jigId)
  await writeJigSource(filePath, args.code, {
    jigId,
    commit: true,
    commitMessage: args.message ? `jig: ${jigId} — ${args.message}` : `jig: ${jigId} — update`,
    commitPrompt: session.authoringIntent,
  })

  return JSON.stringify({ ok: true, path: filePath })
}

async function toolCheckJig(args: { jigId?: string }, session: AgentSession): Promise<string> {
  const jigId = session.jigId ?? args.jigId
  if (!jigId) return JSON.stringify({ error: "No jigId specified" })
  const filePath = resolveJigPath(jigId)
  if (!existsSync(filePath)) return JSON.stringify({ error: `File not found: ${filePath}` })
  const result = await checkJigFile(filePath)
  const code = readFileSync(filePath, "utf-8")
  const extraErrors: string[] = []

  if (session.authoringPolicy.requiresIntegration && hasExplicitEmptyToolsArray(code)) {
    extraErrors.push("Validator behavior.empty-tools: Workflow depends on an integration, but the generated jig declares tools: []. Do not generate an integration-backed jig without real tools.")
  }
  for (const issue of collectBuildTimeToolPolicyIssues(code, session.authoringPolicy.buildResolutions)) {
    extraErrors.push(`Validator behavior.build-time-resolution.${issue.server}: ${issue.message}`)
  }

  if (result === "ok" && extraErrors.length === 0) return "ok"
  return [result === "ok" ? null : result, ...extraErrors].filter(Boolean).join("\n")
}

async function toolBrowse(args: { url: string }): Promise<string> {
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error("Browse timed out after 45s")), 45_000)
  )
  return Promise.race([timeout, _toolBrowse(args)])
}

async function _toolBrowse(args: { url: string }): Promise<string> {
  const url = args.url
  if (url.startsWith("file://") || url.startsWith("/")) {
    return JSON.stringify({ error: "Cannot browse local files. Tool schemas and type definitions are already in your system prompt — look there instead." })
  }
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

const ASK_USER_SENTINEL = "__ASK_USER__"

async function executeAgentTool(name: string, args: Record<string, any>, session: AgentSession): Promise<string> {
  switch (name) {
    case "read_jig_file": return toolReadJigFile(args, session)
    case "write_jig_file": return toolWriteJigFile(args as any, session)
    case "check_jig": return toolCheckJig(args, session)
    case "ask_user": return ASK_USER_SENTINEL
    case "browse": return toolBrowse(args as any)
    case "web_search": return toolWebSearch(args as any)
    default: return JSON.stringify({ error: `Unknown tool: ${name}` })
  }
}

async function buildAgentSystemPrompt(instruction: string, jigId?: string): Promise<{
  prompt: string
  authoringPolicy: AgentSession["authoringPolicy"]
}> {
  let currentCode: string | undefined
  if (jigId) {
    const filePath = resolveJigPath(jigId)
    if (existsSync(filePath)) {
      currentCode = readFileSync(filePath, "utf-8")
    }
  }

  let authoring
  try {
    authoring = await buildAuthoringState(instruction, {
      existingCode: currentCode,
    })
  } catch (error: any) {
    throw new ApiError(400, error?.message ?? "Failed to build authoring context")
  }

  return {
    prompt: buildAgentJigSystemPrompt({
      jigId,
      skillMd: authoring.context.skillMd,
      typeDefs: authoring.context.typeDefs,
      toolCatalog: authoring.context.toolCatalog,
      serverDescriptions: authoring.context.serverDescriptions,
      buildHints: authoring.context.buildHints,
      currentCode,
      exampleJig: authoring.context.exampleJig,
    }),
    authoringPolicy: {
      requiresIntegration: authoring.requiresIntegration || authoring.allServers.length > 0,
      buildResolutions: authoring.buildResolutions,
    },
  }
}

async function runAgentLoop(session: AgentSession): Promise<void> {
  const client = getAgentClient()

  let consecutiveErrors = 0
  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    session.status = "thinking"

    let response
    try {
      response = await client.chat.completions.create({
        model: JIG_EDITOR_MODEL,
        max_tokens: 16384,
        messages: session.messages,
        tools: AGENT_TOOL_DEFS,
      })
    } catch (e: any) {
      consecutiveErrors++
      const msg = e?.message ?? String(e)
      if (consecutiveErrors >= 3) {
        session.events.push({ type: "text", content: `Failed after ${consecutiveErrors} retries: ${msg}` })
        session.status = "error"
        return
      }
      session.events.push({ type: "text", content: `Network error (retry ${consecutiveErrors}/3): ${msg}` })
      await new Promise((r) => setTimeout(r, 2000 * consecutiveErrors))
      continue
    }
    consecutiveErrors = 0

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
    let pendingAsk: { toolCallId: string; question: string; event: AgentEvent } | null = null
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

        // ask_user: defer pause until all other tools in this round are done
        if (result === ASK_USER_SENTINEL) {
          const question = args.question ?? "I have a question for you."
          event.status = "done"
          event.result = question
          pendingAsk = { toolCallId: toolCall.id, question, event }
          continue
        }

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

    // Pause after processing all tools in the round
    if (pendingAsk) {
      session.events.push({ type: "text", content: pendingAsk.question })
      session.pendingAskToolCallId = pendingAsk.toolCallId
      session.pendingAskQuestion = pendingAsk.question
      session.status = "waiting"
      return
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

export async function startAgentSession(body: any): Promise<StartAgentResponse> {
  const instruction = body?.instruction as string
  if (!instruction) throw new ApiError(400, "instruction is required")

  const jigId = body?.jigId as string | undefined

  if (jigId && !isValidJigId(jigId)) throw new ApiError(400, "Invalid jig ID")
  if (jigId && activeAgentJigs.has(jigId)) {
    throw new ApiError(409, "An agent session is already editing this jig")
  }

  const sessionId = crypto.randomUUID()
  const { prompt: systemPrompt, authoringPolicy } = await buildAgentSystemPrompt(instruction, jigId)

  const session: AgentSession = {
    sessionId,
    jigId,
    authoringIntent: instruction,
    authoringPolicy,
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

export function getAgentSessionStatus(sessionId: string, sinceIndex: number): AgentStatusResponse {
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
  if (session.status === "thinking" || session.status === "tool-calling") {
    throw new ApiError(409, "Agent is still processing")
  }

  const message = body?.message as string
  if (!message) throw new ApiError(400, "message is required")

  // If the agent was waiting for an ask_user reply, inject the answer as a tool result
  const pendingToolCallId = session.pendingAskToolCallId
  if (pendingToolCallId) {
    session.authoringIntent = appendAskAnswer(session.authoringIntent, session.pendingAskQuestion, message)
    session.pendingAskToolCallId = undefined
    session.pendingAskQuestion = undefined
    session.messages.push({ role: "tool", tool_call_id: pendingToolCallId, content: message })
  } else {
    session.authoringIntent = appendAuthoringIntent(session.authoringIntent, message)
    const { prompt, authoringPolicy } = await buildAgentSystemPrompt(session.authoringIntent, session.jigId)
    session.authoringPolicy = authoringPolicy
    session.messages[0] = { role: "system", content: prompt }
    session.messages.push({ role: "user", content: message })
  }
  session.status = "thinking"

  runAgentLoop(session).catch((error) => {
    session.status = "error"
    session.events.push({ type: "text", content: error?.message ?? String(error) })
  }).finally(() => {
    if (session.jigId) activeAgentJigs.delete(session.jigId)
  })

  return { ok: true }
}

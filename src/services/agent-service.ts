import { existsSync, readFileSync } from "fs"
import { join } from "path"
import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import type { AgentConversationTurn, AgentDraftApproval, AgentEvent, AgentMetrics, AgentStatusResponse, JigData, OkResponse, StartAgentResponse } from "../../shared/api.js"
import { getEditorModel } from "../config/models.js"
import { SCHEMAS_DIR } from "../config/paths.js"
import { isValidJigId } from "../domain/jig-id.js"
import { getImportedServers } from "../domain/source-analysis.js"
import { prettifyId } from "../domain/jig-source.js"
import { invalidateJigsCache } from "../discover.js"
import { checkJigFile } from "./jig-checker.js"
import { buildAgentJigSystemPrompt } from "./jig-writing-prompt.js"
import { ApiError } from "../server/http.js"
import {
  approvePending as storeApprovePending,
  getActiveCode as storeGetActiveCode,
  getJigRow as storeGetJigRow,
  getPending as storeGetPending,
  renameJig as storeRenameJig,
  writePending as storeWritePending,
} from "./jig-store.js"
import { materializeActiveVersion, materializePendingVersion } from "./jig-runtime.js"
import { requireOpenRouterApiKey } from "../config/openrouter.js"
import { logSessionEvent } from "../debug/session-log.js"
import { buildDraftJigResponse } from "./jig-api.js"
import { toolNameToIdentifier } from "../mcp/typegen.js"
import {
  buildAuthoringState,
  collectBuildTimeToolPolicyIssues,
  CreatorError,
  hasExplicitEmptyToolsArray,
  type BuildTimeResolution,
} from "../jig-gen.js"
import {
  deleteAgentSession,
  getAgentSession,
  jigHasActiveSession,
  listAgentSessions,
  renameJigLocalState,
  setToolPermission,
  upsertAgentSession,
  type AgentSessionRow,
} from "../db.js"

const MAX_AGENT_ROUNDS = 15
const AGENT_SESSION_TTL = 30 * 60 * 1000

type AgentSession = {
  sessionId: string
  jigId?: string
  creationMode: boolean
  authoringIntent: string
  conversationHistory: AgentConversationTurn[]
  authoringPolicy: {
    requiresIntegration: boolean
    buildResolutions: BuildTimeResolution[]
  }
  messages: ChatCompletionMessageParam[]
  events: AgentEvent[]
  status: "thinking" | "tool-calling" | "waiting" | "done" | "error"
  metrics: AgentMetrics
  createdAt: number
  pendingAskToolCallId?: string
  pendingAskQuestion?: string
  draftFilePath?: string
  draftApproval?: AgentDraftApproval
  /** SSE replay cursor — events with seq <= this have been emitted to a stream client at least once. */
  lastEventSeq: number
}

const agentSessions = new Map<string, AgentSession>()
const activeAgentJigs = new Set<string>()
const closedAgentSessions = new Set<string>()

function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

function serializeSession(session: AgentSession): AgentSessionRow {
  return {
    session_id: session.sessionId,
    jig_id: session.jigId ?? null,
    creation_mode: session.creationMode ? 1 : 0,
    authoring_intent: session.authoringIntent,
    conversation_history: JSON.stringify(session.conversationHistory),
    authoring_policy: JSON.stringify(session.authoringPolicy),
    messages: JSON.stringify(session.messages),
    events: JSON.stringify(session.events),
    status: session.status,
    metrics: JSON.stringify(session.metrics),
    created_at: session.createdAt,
    updated_at: Date.now(),
    pending_ask_tool_call_id: session.pendingAskToolCallId ?? null,
    pending_ask_question: session.pendingAskQuestion ?? null,
    draft_file_path: session.draftFilePath ?? null,
    draft_approval: session.draftApproval ? JSON.stringify(session.draftApproval) : null,
    last_event_seq: session.lastEventSeq,
  }
}

function hydrateSession(row: AgentSessionRow): AgentSession {
  return {
    sessionId: row.session_id,
    jigId: row.jig_id ?? undefined,
    creationMode: row.creation_mode === 1,
    authoringIntent: row.authoring_intent,
    conversationHistory: parseJson<AgentConversationTurn[]>(row.conversation_history, []),
    authoringPolicy: parseJson<AgentSession["authoringPolicy"]>(row.authoring_policy, {
      requiresIntegration: false,
      buildResolutions: [],
    }),
    messages: parseJson<ChatCompletionMessageParam[]>(row.messages, []),
    events: parseJson<AgentEvent[]>(row.events, []),
    status: row.status as AgentSession["status"],
    metrics: parseJson<AgentMetrics>(row.metrics, {}),
    createdAt: row.created_at,
    pendingAskToolCallId: row.pending_ask_tool_call_id ?? undefined,
    pendingAskQuestion: row.pending_ask_question ?? undefined,
    draftFilePath: row.draft_file_path ?? undefined,
    draftApproval: parseJson<AgentDraftApproval | undefined>(row.draft_approval, undefined),
    lastEventSeq: row.last_event_seq ?? 0,
  }
}

function persistSession(session: AgentSession): void {
  if (closedAgentSessions.has(session.sessionId)) return
  upsertAgentSession(serializeSession(session))
  // Pass the live session object so the SSE handler doesn't need to re-load
  // from the DB on every frame — hot path.
  notifySessionStream(session.sessionId, session)
}

// ---------------------------------------------------------------------------
// SSE streaming — one EventEmitter per session, fires whenever session state
// changes (after each persistSession). Subscribers maintain their own cursor.
// ---------------------------------------------------------------------------
import { EventEmitter } from "events"
const sessionStreams = new Map<string, EventEmitter>()

function getSessionStream(sessionId: string): EventEmitter {
  let stream = sessionStreams.get(sessionId)
  if (!stream) {
    stream = new EventEmitter()
    stream.setMaxListeners(50)
    sessionStreams.set(sessionId, stream)
  }
  return stream
}

function notifySessionStream(sessionId: string, session?: AgentSession): void {
  sessionStreams.get(sessionId)?.emit("frame", session)
}

function disposeSessionStream(sessionId: string): void {
  const stream = sessionStreams.get(sessionId)
  if (stream) {
    stream.removeAllListeners()
    sessionStreams.delete(sessionId)
  }
}

function isSessionClosed(session: AgentSession): boolean {
  return closedAgentSessions.has(session.sessionId) || agentSessions.get(session.sessionId) !== session
}

function stopIfClosed(session: AgentSession): boolean {
  if (!isSessionClosed(session)) return false
  clearDraft(session)
  if (session.jigId) activeAgentJigs.delete(session.jigId)
  return true
}

function setSessionStatus(session: AgentSession, status: AgentSession["status"]): void {
  const wasActive = session.status === "thinking" || session.status === "tool-calling"
  const willBeActive = status === "thinking" || status === "tool-calling"
  const changed = session.status !== status
  session.status = status
  if (willBeActive && (changed || !wasActive || !session.metrics.activeStartedAt)) {
    session.metrics = { ...session.metrics, activeStartedAt: Date.now(), updatedAt: Date.now() }
  } else if (!willBeActive && session.metrics.activeStartedAt != null) {
    const { activeStartedAt, ...metrics } = session.metrics
    void activeStartedAt
    session.metrics = { ...metrics, updatedAt: Date.now() }
  }
}

function markInterruptedIfNeeded(session: AgentSession): AgentSession {
  if (session.status !== "thinking" && session.status !== "tool-calling") return session
  for (const event of session.events) {
    if (event.type === "tool-call" && event.status === "running") {
      event.status = "error"
      event.result = "Interrupted by server restart"
    }
  }
  session.events.push({
    type: "text",
    content: "Agent work was interrupted by a server restart. Reply with the next change or ask it to continue.",
  })
  setSessionStatus(session, "waiting")
  session.metrics = { ...session.metrics, activeTool: undefined, updatedAt: Date.now() }
  persistSession(session)
  return session
}

function loadSession(sessionId: string): AgentSession | null {
  if (closedAgentSessions.has(sessionId)) return null
  const existing = agentSessions.get(sessionId)
  if (existing) return existing
  const row = getAgentSession(sessionId)
  if (!row) return null
  const session = markInterruptedIfNeeded(hydrateSession(row))
  agentSessions.set(session.sessionId, session)
  if (session.jigId && session.status !== "done" && session.status !== "error") {
    activeAgentJigs.add(session.jigId)
  }
  return session
}

function placeholderDraftId(sessionId: string): string {
  return `draft-${sessionId.slice(0, 8)}`
}

function draftNameFromSession(session: AgentSession): string {
  if (session.jigId) return prettifyId(session.jigId)
  const firstUserTurn = session.conversationHistory.find((turn) => turn.role === "user")?.content.trim()
  if (!firstUserTurn) return "New Jig Draft"
  const singleLine = firstUserTurn.replace(/\s+/g, " ")
  return singleLine.length > 36 ? `${singleLine.slice(0, 33)}...` : singleLine
}

function estimateTokens(value: unknown): number {
  if (value == null) return 0
  const text = typeof value === "string" ? value : JSON.stringify(value)
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

function estimateRequestPromptTokens(messages: ChatCompletionMessageParam[], tools: ChatCompletionTool[]): number {
  const messageTokens = messages.reduce((sum, message) => sum + estimateTokens(message), 0)
  const toolTokens = tools.reduce((sum, tool) => sum + estimateTokens(tool), 0)
  return messageTokens + toolTokens
}

function clearDraft(session: AgentSession): void {
  // v12: pending in the store is durable across sessions — the next session
  // for this jig inherits it. Closing/timing-out a session does NOT discard
  // pending; that requires an explicit user action via the discard endpoint.
  // We only clear session-local state here.
  session.draftFilePath = undefined
  session.draftApproval = undefined
}

function getDraftCode(session: AgentSession): string | null {
  if (!session.jigId) return null
  return storeGetPending(session.jigId)?.code ?? null
}

async function getSessionCode(session: AgentSession, jigId?: string): Promise<string | null> {
  const resolvedJigId = session.jigId ?? jigId
  if (!resolvedJigId) return null
  // Prefer pending (agent is mid-edit), else the active version. Both live in
  // the store — there is no filesystem fallback. The boot-time migration is
  // the only path that imports legacy jigs/*.ts files.
  return storeGetPending(resolvedJigId)?.code ?? storeGetActiveCode(resolvedJigId)
}

function releaseSession(session: AgentSession): void {
  closedAgentSessions.add(session.sessionId)
  clearDraft(session)
  if (session.jigId) activeAgentJigs.delete(session.jigId)
  agentSessions.delete(session.sessionId)
  deleteAgentSession(session.sessionId)
  disposeSessionStream(session.sessionId)
}

/**
 * Returns true if no other live session is editing this jig — caller is safe to claim.
 * v12: lock lives entirely in agent_sessions status; pending in the store is durable
 * across sessions, but only one session can be actively writing at a time.
 */
function releaseStaleJigLock(jigId: string): boolean {
  const ACTIVE = new Set(["thinking", "tool-calling", "waiting"])
  // Drop in-memory locks for terminal/missing sessions on the same jig.
  for (const session of [...agentSessions.values()]) {
    if (session.jigId !== jigId) continue
    if (!ACTIVE.has(session.status)) {
      releaseSession(session)
    }
  }
  // O(1) indexed lookup — does any live session claim this jig?
  if (jigHasActiveSession(jigId)) return false
  activeAgentJigs.delete(jigId)
  return true
}

function hasPersistedDraftForJig(_jigId: string, _sessionId: string): boolean {
  // v12: pending is durable in jig_versions and freely inheritable by the next
  // session. We don't refuse a new session on the basis of a leftover pending —
  // the lock check (releaseStaleJigLock) is the only gate that matters.
  return false
}

function hasCompletedTool(session: AgentSession, tool: string): boolean {
  return session.events.some((event) =>
    event.type === "tool-call" && event.tool === tool && event.status === "done"
  )
}

function pruneAgentSessions() {
  const now = Date.now()
  for (const [id, session] of agentSessions) {
    if (now - session.createdAt > AGENT_SESSION_TTL) {
      // v12: don't touch pending here — it's durable across sessions and the
      // next session that opens this jig can pick it up. Only prune the session
      // row itself; the pending stays.
      if (session.jigId) activeAgentJigs.delete(session.jigId)
      agentSessions.delete(id)
      deleteAgentSession(id)
      disposeSessionStream(id)
    }
  }
}

export function normalizeConversationHistory(
  history: unknown,
  latestUserMessage?: string
): AgentConversationTurn[] {
  const normalized = Array.isArray(history)
    ? history
        .filter((turn): turn is AgentConversationTurn =>
          Boolean(turn)
          && typeof turn === "object"
          && (((turn as any).role === "user") || ((turn as any).role === "assistant"))
          && typeof (turn as any).content === "string"
        )
        .map((turn) => ({
          role: turn.role,
          content: turn.content.trim(),
        }))
        .filter((turn) => Boolean(turn.content))
    : []

  const trimmedLatest = latestUserMessage?.trim()
  if (!trimmedLatest) return normalized

  const last = normalized[normalized.length - 1]
  if (last?.role === "user" && last.content === trimmedLatest) return normalized
  return [...normalized, { role: "user", content: trimmedLatest }]
}

export function renderConversationIntent(history: AgentConversationTurn[]): string {
  if (history.length === 0) return ""
  return history
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.content}`)
    .join("\n\n")
}

function buildConversationMessages(history: AgentConversationTurn[]): ChatCompletionMessageParam[] {
  return history.map((turn) => ({
    role: turn.role,
    content: turn.content,
  }))
}

function setSessionConversationHistory(
  session: AgentSession,
  history: AgentConversationTurn[],
  fallbackUserMessage?: string
): void {
  if (history.length > 0) {
    session.conversationHistory = history
  } else if (fallbackUserMessage?.trim()) {
    session.conversationHistory = [...session.conversationHistory, { role: "user", content: fallbackUserMessage.trim() }]
  }
  session.authoringIntent = renderConversationIntent(session.conversationHistory)
}

function getAgentClient(): OpenAI {
  try {
    const apiKey = requireOpenRouterApiKey()
    return new OpenAI({ baseURL: "https://openrouter.ai/api/v1", apiKey })
  } catch (e: any) {
    throw new ApiError(500, e?.message ?? "OpenRouter API key not set")
  }
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
      description: "Write full TypeScript source code to a jig file. New jigs are staged as drafts until approved; existing jigs are written directly.",
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
      name: "get_tool_schema",
      description: "Inspect cached MCP tool schemas. Use this when exact params or return-shape docs are needed but not present in the prompt. Provide server only to list tools, or server + toolName for a full schema.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Connection/server key, e.g. workspace, granola, apify, composio" },
          toolName: { type: "string", description: "Optional MCP tool name or generated TypeScript identifier" },
        },
        required: ["server"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "rename_jig",
      description: "Rename the session's jig. Moves the file, updates the jig() name string in code, carries over run history and schedules, and commits. Use this for rename requests instead of read+write.",
      parameters: {
        type: "object",
        properties: {
          newJigId: { type: "string", description: "New jig ID (lowercase letters, numbers, dashes, underscores)" },
        },
        required: ["newJigId"],
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
  const code = await getSessionCode(session, jigId)
  if (!code) return JSON.stringify({ error: `File not found for jig: ${jigId}` })
  return code
}

async function toolWriteJigFile(args: { code: string; jigId?: string; message?: string }, session: AgentSession): Promise<string> {
  const jigId = session.jigId ?? args.jigId
  if (!jigId) return JSON.stringify({ error: "No jigId specified — provide jigId for new jigs" })
  if (!isValidJigId(jigId)) return JSON.stringify({ error: "Invalid jigId. Use lowercase letters, numbers, dashes, or underscores." })

  const disconnected = findDisconnectedImports(args.code)
  if (disconnected.length > 0) {
    return JSON.stringify({
      error: `Code imports unconnected servers: ${disconnected.join(", ")}. Either ask the user to run 'jig connect <server>' and wait, or rewrite the jig to not depend on those servers.`,
      disconnectedServers: disconnected,
    })
  }

  // First write claims the jig for this session. If another session is
  // actively editing the same jig, refuse.
  if (!session.jigId) {
    if (!releaseStaleJigLock(jigId)) return JSON.stringify({ error: "Another session is already editing this jig" })
    if (session.creationMode && storeGetJigRow(jigId)) {
      return JSON.stringify({ error: `Jig already exists: ${jigId}` })
    }
    session.jigId = jigId
    activeAgentJigs.add(jigId)
  }

  // v12: every write — create or edit — goes to pending. Approve promotes.
  const { versionId } = storeWritePending({
    jigId,
    name: prettifyId(jigId),
    code: args.code,
    author: "agent",
    message: args.message ?? null,
    prompt: session.authoringIntent || null,
  })

  // The previous `draftApproval` cache is now derivable from getPending(jigId);
  // clear it here so consumers refetch and don't see stale approval data.
  session.draftFilePath = undefined
  session.draftApproval = undefined
  persistSession(session)
  return JSON.stringify({ ok: true, pendingVersionId: versionId, draft: true })
}

async function toolCheckJig(args: { jigId?: string }, session: AgentSession): Promise<string> {
  const jigId = session.jigId ?? args.jigId
  if (!jigId) return JSON.stringify({ error: "No jigId specified" })
  const code = await getSessionCode(session, jigId)
  if (!code) return JSON.stringify({ error: `File not found for jig: ${jigId}` })

  // Check whichever version is currently the source of truth — pending if
  // the agent is editing it, otherwise the active version. Both materialize
  // out of the store.
  const target = (await materializePendingVersion(jigId)) ?? (await materializeActiveVersion(jigId))
  if (!target) return JSON.stringify({ error: `No code on disk for jig: ${jigId}` })
  const result = await checkJigFile(target.path)
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

function firstSchemaLine(value: unknown): string {
  return String(value ?? "").split("\n")[0].trim()
}

async function toolGetToolSchema(args: { server?: string; toolName?: string }): Promise<string> {
  const server = args.server?.trim()
  if (!server || !/^[a-zA-Z0-9_-]+$/.test(server)) {
    return JSON.stringify({ error: "Invalid server name" })
  }

  const schemaPath = join(SCHEMAS_DIR, `${server}.json`)
  if (!existsSync(schemaPath)) {
    return JSON.stringify({ error: `No cached schema for server: ${server}` })
  }

  let schemas: any[]
  try {
    schemas = JSON.parse(readFileSync(schemaPath, "utf-8"))
  } catch (error: any) {
    return JSON.stringify({ error: error?.message ?? `Failed to read schema for ${server}` })
  }

  const requestedTool = args.toolName?.trim()
  if (!requestedTool) {
    return JSON.stringify({
      server,
      tools: schemas.map((tool) => ({
        name: tool.name,
        identifier: toolNameToIdentifier(tool.name),
        description: firstSchemaLine(tool.description),
      })),
    })
  }

  const tool = schemas.find((candidate) =>
    candidate?.name === requestedTool || toolNameToIdentifier(candidate?.name ?? "") === requestedTool
  )
  if (!tool) {
    return JSON.stringify({
      error: `Tool not found: ${server}.${requestedTool}`,
      available: schemas.map((candidate) => ({
        name: candidate.name,
        identifier: toolNameToIdentifier(candidate.name),
      })),
    })
  }

  return JSON.stringify({
    server,
    name: tool.name,
    identifier: toolNameToIdentifier(tool.name),
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: tool.annotations,
  })
}

async function toolRenameJig(args: { newJigId: string }, session: AgentSession): Promise<string> {
  const oldJigId = session.jigId
  if (!oldJigId) return JSON.stringify({ error: "No jig in this session to rename" })
  const newJigId = args.newJigId
  if (!isValidJigId(newJigId)) {
    return JSON.stringify({ error: "Invalid newJigId. Use lowercase letters, numbers, dashes, or underscores." })
  }
  if (newJigId === oldJigId) return JSON.stringify({ error: "newJigId matches current jigId" })
  if (storeGetJigRow(newJigId)) {
    return JSON.stringify({ error: `Jig already exists: ${newJigId}` })
  }
  if (!releaseStaleJigLock(newJigId)) {
    return JSON.stringify({ error: "Another session is already editing this jig" })
  }

  // Rename the jig in the store. storeRenameJig rewrites the `jig("oldId")`
  // identifier inside every version's code atomically — no follow-up needed.
  storeRenameJig(oldJigId, newJigId)
  renameJigLocalState(oldJigId, newJigId)
  invalidateJigsCache()
  activeAgentJigs.delete(oldJigId)
  activeAgentJigs.add(newJigId)
  session.jigId = newJigId
  session.draftFilePath = undefined
  session.draftApproval = undefined
  persistSession(session)
  return JSON.stringify({ ok: true, oldJigId, newJigId, draft: storeGetPending(newJigId) != null })
}

function findDisconnectedImports(code: string): string[] {
  const servers = getImportedServers(code)
  return servers.filter((server) => !existsSync(join(SCHEMAS_DIR, `${server}.json`)))
}

function rewriteJigIdentifier(code: string, newJigId: string): string {
  let replaced = false
  return code.replace(/jig\(\s*(["'`])([^"'`]+)\1/, (match, quote: string) => {
    if (replaced) return match
    replaced = true
    return `jig(${quote}${newJigId}${quote}`
  })
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
    case "get_tool_schema": return toolGetToolSchema(args as any)
    case "rename_jig": return toolRenameJig(args as any, session)
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
  return buildAgentSystemPromptWithCode(instruction, jigId)
}

async function buildAgentSystemPromptWithCode(
  instruction: string,
  jigId?: string,
  currentCode?: string
): Promise<{
  prompt: string
  authoringPolicy: AgentSession["authoringPolicy"]
}> {
  let nextCurrentCode = currentCode
  if (!nextCurrentCode && jigId) {
    nextCurrentCode = storeGetPending(jigId)?.code ?? storeGetActiveCode(jigId) ?? ""
  }

  let authoring
  try {
    authoring = await buildAuthoringState(instruction, {
      existingCode: nextCurrentCode,
    })
  } catch (error: any) {
    if (error instanceof CreatorError) {
      throw new ApiError(400, error.message, error.details)
    }
    throw new ApiError(400, error?.message ?? "Failed to build authoring context")
  }

  return {
    prompt: buildAgentJigSystemPrompt({
      jigId,
      skillMd: authoring.context.skillMd,
      typeDefs: authoring.context.typeDefs,
      toolCatalog: authoring.context.toolCatalog,
      relevantSchemas: authoring.context.relevantSchemas,
      serverDescriptions: authoring.context.serverDescriptions,
      buildHints: authoring.context.buildHints,
      currentCode: nextCurrentCode,
      exampleJig: authoring.context.exampleJig,
    }),
    authoringPolicy: {
      requiresIntegration: authoring.requiresIntegration || authoring.allServers.length > 0,
      buildResolutions: authoring.buildResolutions,
    },
  }
}

async function buildDraftApproval(session: AgentSession): Promise<AgentDraftApproval> {
  if (!session.jigId) throw new Error("No draft is available to approve")
  const pending = storeGetPending(session.jigId)
  if (!pending) throw new Error("No draft is available to approve")
  // Materialize pending to a real path so introspectJig can import it for
  // tool extraction. introspectJig falls back to regex parsing if import fails.
  const materialized = await materializePendingVersion(session.jigId)
  return {
    jig: await buildDraftJigResponse(session.jigId, pending.code, materialized?.path ?? "", true),
  }
}

async function prepareDraftApproval(session: AgentSession): Promise<AgentDraftApproval | null> {
  if (!session.jigId || !storeGetPending(session.jigId)) {
    session.messages.push({
      role: "user",
      content: "No approvable draft exists yet. Write the jig file, then run check_jig until it returns ok.",
    })
    return null
  }
  const materialized = await materializePendingVersion(session.jigId)
  if (!materialized) {
    session.messages.push({
      role: "user",
      content: "Could not materialize the pending version for validation. Try writing the jig again.",
    })
    return null
  }
  const checkResult = await checkJigFile(materialized.path)
  if (checkResult !== "ok") {
    session.messages.push({
      role: "user",
      content: `The draft is not ready. check_jig reports:\n${checkResult}\n\nDo not claim completion yet. Patch the jig, then run check_jig until it returns ok.`,
    })
    return null
  }
  return buildDraftApproval(session)
}

async function approveDraft(session: AgentSession): Promise<void> {
  if (!session.jigId) throw new ApiError(409, "No pending draft approval")
  const pending = storeGetPending(session.jigId)
  if (!pending) throw new ApiError(409, "No pending draft approval")

  // v12: promote pending to active in one atomic store call. No filesystem
  // writes, no git commits — the version row already holds the code, we just
  // move the active pointer.
  storeApprovePending(session.jigId)

  // Auto-approve every tool declared by the approved code, whether this is a
  // create or an edit. Sourced from the materialized active version so the
  // behavior is symmetric across flows (the old code path only ran for
  // creation, leaving edit-introduced tools waiting in the tool-review UI).
  try {
    const materialized = await materializeActiveVersion(session.jigId)
    if (materialized) {
      const introspected = await buildDraftJigResponse(session.jigId, pending.code, materialized.path, false)
      for (const tool of introspected.settings.tools ?? []) {
        setToolPermission(tool.connection, tool.name, "always")
      }
    }
  } catch {
    // Tool introspection is best-effort; failing it should not block approval.
  }

  invalidateJigsCache()
  activeAgentJigs.delete(session.jigId)
  session.draftFilePath = undefined
  session.draftApproval = undefined
  deleteAgentSession(session.sessionId)
  session.events.push({ type: "text", content: `Approved changes to ${session.jigId}.` })
  setSessionStatus(session, "done")
  logSessionEvent({
    source: "authoring.agent",
    event: "draft-approved",
    sessionId: session.sessionId,
    jigId: session.jigId,
  })
}

async function runAgentLoop(session: AgentSession): Promise<void> {
  const client = getAgentClient()

  let consecutiveErrors = 0
  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    if (stopIfClosed(session)) return
    const estimatedPromptTokens = estimateRequestPromptTokens(session.messages, AGENT_TOOL_DEFS)
    setSessionStatus(session, "thinking")
    session.metrics = {
      ...session.metrics,
      model: getEditorModel(),
      round: round + 1,
      activeTool: undefined,
      estimatedPromptTokens,
      updatedAt: Date.now(),
    }
    persistSession(session)
    logSessionEvent({
      source: "authoring.agent",
      event: "status",
      sessionId: session.sessionId,
      jigId: session.jigId,
      status: session.status,
      round,
    })

    let response
    try {
      logSessionEvent({
        source: "authoring.agent",
        event: "request",
        sessionId: session.sessionId,
        jigId: session.jigId,
        round,
        model: getEditorModel(),
        messages: session.messages,
        tools: AGENT_TOOL_DEFS,
      })
      response = await client.chat.completions.create({
        model: getEditorModel(),
        max_tokens: 16384,
        messages: session.messages,
        tools: AGENT_TOOL_DEFS,
      })
      if (stopIfClosed(session)) return
    } catch (e: any) {
      if (stopIfClosed(session)) return
      logSessionEvent({
        source: "authoring.agent",
        event: "request-error",
        sessionId: session.sessionId,
        jigId: session.jigId,
        round,
        model: getEditorModel(),
        error: e,
      })
      consecutiveErrors++
      const msg = e?.message ?? String(e)
      if (consecutiveErrors >= 3) {
        session.events.push({ type: "text", content: `Failed after ${consecutiveErrors} retries: ${msg}` })
        setSessionStatus(session, "error")
        persistSession(session)
        return
      }
      session.events.push({ type: "text", content: `Network error (retry ${consecutiveErrors}/3): ${msg}` })
      persistSession(session)
      await new Promise((r) => setTimeout(r, 2000 * consecutiveErrors))
      continue
    }
    consecutiveErrors = 0
    if (stopIfClosed(session)) return

    const msg = response.choices[0]?.message
    if (!msg) {
      setSessionStatus(session, "error")
      persistSession(session)
      logSessionEvent({
        source: "authoring.agent",
        event: "empty-response",
        sessionId: session.sessionId,
        jigId: session.jigId,
        round,
        model: getEditorModel(),
        usage: response.usage,
      })
      return
    }
    logSessionEvent({
      source: "authoring.agent",
      event: "response",
      sessionId: session.sessionId,
      jigId: session.jigId,
      round,
      model: getEditorModel(),
      message: msg,
      finishReason: response.choices[0]?.finish_reason,
      usage: response.usage,
    })
    session.metrics = {
      ...session.metrics,
      model: getEditorModel(),
      round: round + 1,
      estimatedPromptTokens: response.usage?.prompt_tokens ?? session.metrics.estimatedPromptTokens,
      promptTokens: response.usage?.prompt_tokens,
      completionTokens: response.usage?.completion_tokens,
      totalTokens: response.usage?.total_tokens,
      updatedAt: Date.now(),
    }

    session.messages.push(msg as ChatCompletionMessageParam)
    persistSession(session)

    if (!msg.tool_calls?.length) {
      session.events.push({ type: "text", content: msg.content ?? "" })
      if (session.creationMode) {
        const draftApproval = await prepareDraftApproval(session)
        if (draftApproval) {
          session.draftApproval = draftApproval
          session.events.push({
            type: "text",
            content: `Draft ready. Approve to create ${session.jigId}, or reply with changes to revise it.`,
          })
          setSessionStatus(session, "waiting")
          persistSession(session)
          logSessionEvent({
            source: "authoring.agent",
            event: "draft-ready",
            sessionId: session.sessionId,
            jigId: session.jigId,
            round,
            reason: "final-response-check-ok",
          })
          return
        }
        if (round + 1 >= MAX_AGENT_ROUNDS) {
          session.events.push({
            type: "text",
            content: "Draft is still under construction because it has not passed the jig check.",
          })
          setSessionStatus(session, "error")
          persistSession(session)
          logSessionEvent({
            source: "authoring.agent",
            event: "draft-not-ready",
            sessionId: session.sessionId,
            jigId: session.jigId,
            round,
            reason: "final-response-without-valid-draft",
          })
          return
        }
        session.events.push({
          type: "text",
          content: "Draft is not ready yet; continuing because the jig check has not passed.",
        })
        persistSession(session)
        logSessionEvent({
          source: "authoring.agent",
          event: "draft-not-ready",
          sessionId: session.sessionId,
          jigId: session.jigId,
          round,
          reason: "final-response-without-valid-draft",
        })
        continue
      }
      setSessionStatus(session, "done")
      persistSession(session)
      logSessionEvent({
        source: "authoring.agent",
        event: "done",
        sessionId: session.sessionId,
        jigId: session.jigId,
        round,
        content: msg.content ?? "",
      })
      return
    }

    setSessionStatus(session, "tool-calling")
    session.metrics = {
      ...session.metrics,
      round: round + 1,
      updatedAt: Date.now(),
    }
    persistSession(session)
    logSessionEvent({
      source: "authoring.agent",
      event: "status",
      sessionId: session.sessionId,
      jigId: session.jigId,
      status: session.status,
      round,
    })
    let roundHadToolError = false
    let roundHadSuccessfulCheck = false
    let pendingAsk: { toolCallId: string; question: string; event: AgentEvent } | null = null
    for (const toolCall of msg.tool_calls) {
      if (stopIfClosed(session)) return
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
      session.metrics = {
        ...session.metrics,
        activeTool: toolCall.function.name,
        updatedAt: Date.now(),
      }
      persistSession(session)
      logSessionEvent({
        source: "authoring.agent",
        event: "tool-start",
        sessionId: session.sessionId,
        jigId: session.jigId,
        round,
        tool: toolCall.function.name,
        args,
      })

      try {
        const result = await executeAgentTool(toolCall.function.name, args, session)
        if (stopIfClosed(session)) return

        // ask_user: defer pause until all other tools in this round are done
        if (result === ASK_USER_SENTINEL) {
          const question = args.question ?? "I have a question for you."
          event.status = "done"
          event.result = question
          logSessionEvent({
            source: "authoring.agent",
            event: "tool-ask-user",
            sessionId: session.sessionId,
            jigId: session.jigId,
            round,
            tool: toolCall.function.name,
            args,
            question,
          })
          pendingAsk = { toolCallId: toolCall.id, question, event }
          persistSession(session)
          continue
        }

        event.status = "done"
        event.result = result
        session.metrics = {
          ...session.metrics,
          activeTool: session.metrics.activeTool === toolCall.function.name ? undefined : session.metrics.activeTool,
          updatedAt: Date.now(),
        }
        logSessionEvent({
          source: "authoring.agent",
          event: "tool-done",
          sessionId: session.sessionId,
          jigId: session.jigId,
          round,
          tool: toolCall.function.name,
          args,
          result,
        })
        if (toolCall.function.name === "check_jig" && result === "ok") {
          roundHadSuccessfulCheck = true
        }
        session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: result })
        persistSession(session)
      } catch (e: any) {
        if (stopIfClosed(session)) return
        event.status = "error"
        event.result = e?.message ?? String(e)
        session.metrics = {
          ...session.metrics,
          activeTool: session.metrics.activeTool === toolCall.function.name ? undefined : session.metrics.activeTool,
          updatedAt: Date.now(),
        }
        roundHadToolError = true
        logSessionEvent({
          source: "authoring.agent",
          event: "tool-error",
          sessionId: session.sessionId,
          jigId: session.jigId,
          round,
          tool: toolCall.function.name,
          args,
          error: e,
        })
        session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error: e?.message }) })
        persistSession(session)
      }
    }
    if (stopIfClosed(session)) return

    // Pause after processing all tools in the round
    if (pendingAsk) {
      session.events.push({ type: "text", content: pendingAsk.question })
      session.pendingAskToolCallId = pendingAsk.toolCallId
      session.pendingAskQuestion = pendingAsk.question
      setSessionStatus(session, "waiting")
      persistSession(session)
      logSessionEvent({
        source: "authoring.agent",
        event: "status",
        sessionId: session.sessionId,
        jigId: session.jigId,
        status: session.status,
        round,
        question: pendingAsk.question,
      })
      return
    }

    if (!roundHadToolError && roundHadSuccessfulCheck && hasCompletedTool(session, "write_jig_file")) {
      if (session.creationMode && getDraftCode(session)) {
        session.draftApproval = await buildDraftApproval(session)
        session.events.push({
          type: "text",
          content: `Draft ready. Approve to create ${session.jigId}, or reply with changes to revise it.`,
        })
        setSessionStatus(session, "waiting")
        persistSession(session)
        logSessionEvent({
          source: "authoring.agent",
          event: "draft-ready",
          sessionId: session.sessionId,
          jigId: session.jigId,
          round,
        })
        return
      }
      session.events.push({
        type: "text",
        content: session.jigId
          ? `Updated ${session.jigId} and it passed the jig check.`
          : "Jig written and it passed the jig check.",
      })
      setSessionStatus(session, "done")
      persistSession(session)
      logSessionEvent({
        source: "authoring.agent",
        event: "done",
        sessionId: session.sessionId,
        jigId: session.jigId,
        round,
        reason: "write-and-check-ok",
      })
      return
    }
  }

  session.events.push({ type: "text", content: "Agent reached maximum rounds." })
  setSessionStatus(session, "done")
  persistSession(session)
  logSessionEvent({
    source: "authoring.agent",
    event: "done",
    sessionId: session.sessionId,
    jigId: session.jigId,
    reason: "max-rounds",
  })
}

export async function startAgentSession(body: any): Promise<StartAgentResponse> {
  const instruction = body?.instruction as string
  if (!instruction) throw new ApiError(400, "instruction is required")

  const jigId = body?.jigId as string | undefined

  if (jigId && !isValidJigId(jigId)) throw new ApiError(400, "Invalid jig ID")
  if (jigId && !releaseStaleJigLock(jigId)) {
    throw new ApiError(409, "An agent session is already editing this jig")
  }

  const conversationHistory = normalizeConversationHistory(body?.history, instruction)
  const authoringIntent = renderConversationIntent(conversationHistory) || instruction
  const sessionId = crypto.randomUUID()
  closedAgentSessions.delete(sessionId)
  const { prompt: systemPrompt, authoringPolicy } = await buildAgentSystemPrompt(authoringIntent, jigId)

  const session: AgentSession = {
    sessionId,
    jigId,
    creationMode: !jigId,
    authoringIntent,
    conversationHistory,
    authoringPolicy,
    messages: [
      { role: "system", content: systemPrompt },
      ...buildConversationMessages(conversationHistory),
    ],
    events: [],
    status: "thinking",
    metrics: {
      model: getEditorModel(),
      round: 1,
      activeStartedAt: Date.now(),
      updatedAt: Date.now(),
    },
    createdAt: Date.now(),
    lastEventSeq: 0,
  }

  pruneAgentSessions()
  agentSessions.set(sessionId, session)
  if (jigId) activeAgentJigs.add(jigId)
  persistSession(session)
  logSessionEvent({
    source: "authoring.agent",
    event: "session-start",
    sessionId,
    jigId,
    instruction,
    authoringIntent,
    conversationHistory,
    systemPrompt,
  })

  runAgentLoop(session).catch((error) => {
    if (isSessionClosed(session)) return
    setSessionStatus(session, "error")
    session.events.push({ type: "text", content: error?.message ?? String(error) })
    persistSession(session)
    logSessionEvent({
      source: "authoring.agent",
      event: "fatal-error",
      sessionId: session.sessionId,
      jigId: session.jigId,
      error,
    })
  })

  return { sessionId, jigId }
}

export function getAgentSessionStatus(sessionId: string, sinceIndex: number): AgentStatusResponse {
  const session = loadSession(sessionId)
  if (!session) throw new ApiError(404, "Session not found")

  return {
    status: session.status,
    jigId: session.jigId,
    events: session.events.slice(sinceIndex),
    totalEvents: session.events.length,
    metrics: session.metrics,
    draftApproval: session.draftApproval,
    conversationHistory: session.conversationHistory,
  }
}

export async function listUnderConstructionJigs(): Promise<JigData[]> {
  const rows = listAgentSessions()
  const drafts: JigData[] = []
  const seen = new Set<string>()

  for (const row of rows) {
    const liveSession = agentSessions.get(row.session_id)
    const session = liveSession ?? markInterruptedIfNeeded(hydrateSession(row))
    if (!session.creationMode) continue
    // Only show drafts whose jig hasn't been approved (i.e. the jigs row has
    // no active version yet — still in "new" lifecycle state).
    if (session.jigId) {
      const jig = storeGetJigRow(session.jigId)
      if (jig?.active_version_id != null) continue
    }

    const listId = placeholderDraftId(session.sessionId)
    if (seen.has(listId)) continue
    seen.add(listId)

    const code = getDraftCode(session)
    const materialized = session.jigId ? await materializePendingVersion(session.jigId) : null
    const jig = session.jigId && materialized && code !== null
      ? await buildDraftJigResponse(session.jigId, code, materialized.path, true)
      : {
        id: listId,
        name: draftNameFromSession(session),
        trigger: "",
        status: "attention",
        running: false,
        sparkline: [],
        steps: [],
        code: code ?? "",
        runs: [],
        settings: {
          trigger: "",
          connections: [],
          tools: [],
          permissions: [],
        },
        costMonth: "",
        costLifetime: "",
      } satisfies JigData

    jig.id = listId
    jig.name = draftNameFromSession(session)

    jig.underConstruction = {
      sessionId: session.sessionId,
      jigId: session.jigId,
      status: session.status,
      updatedAt: new Date(row.updated_at).toISOString(),
    }
    drafts.push(jig)
  }

  return drafts
}

export async function approveAgentDraft(sessionId: string): Promise<OkResponse> {
  const session = loadSession(sessionId)
  if (!session) throw new ApiError(404, "Session not found")
  if (session.status !== "waiting" || !session.draftApproval) {
    throw new ApiError(409, "No pending draft approval")
  }

  await approveDraft(session)
  return { ok: true }
}

export async function closeAgentSession(sessionId: string): Promise<OkResponse> {
  const session = loadSession(sessionId)
  if (!session) return { ok: true }
  releaseSession(session)
  return { ok: true }
}

/**
 * Server-Sent Events stream of agent session updates. Each frame is the
 * AgentStatusResponse shape with only new events since the client's cursor.
 *
 * Frame format: `id: <seq>\nevent: snapshot\ndata: <json>\n\n` where seq is
 * session.events.length at emit time. Clients pass Last-Event-ID on
 * reconnect to skip already-seen events.
 */
export function streamAgentSession(sessionId: string, lastEventId: number, signal: AbortSignal): Response {
  const session = loadSession(sessionId)
  if (!session) throw new ApiError(404, "Session not found")

  const stream = getSessionStream(sessionId)
  let cursor = Number.isFinite(lastEventId) && lastEventId >= 0 ? lastEventId : 0

  const body = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder()
      let closed = false
      let lastStatusSent: AgentSession["status"] | null = null

      const send = (seq: number, payload: AgentStatusResponse) => {
        if (closed) return
        const frame = `id: ${seq}\nevent: snapshot\ndata: ${JSON.stringify(payload)}\n\n`
        try { controller.enqueue(encoder.encode(frame)) } catch { closed = true }
      }
      const heartbeat = () => {
        if (closed) return
        try { controller.enqueue(encoder.encode(":\n\n")) } catch { closed = true }
      }

      const push = (incoming?: AgentSession) => {
        // Use the live session passed by the emitter when available; only fall
        // back to a DB load when there isn't one (e.g. the initial replay).
        const s = incoming ?? loadSession(sessionId)
        if (!s) {
          if (!closed) { try { controller.close() } catch {} closed = true }
          return
        }
        const seq = s.events.length
        if (seq <= cursor && s.status === lastStatusSent) return
        lastStatusSent = s.status
        send(seq, {
          status: s.status,
          jigId: s.jigId,
          events: s.events.slice(cursor),
          totalEvents: seq,
          metrics: s.metrics,
          draftApproval: s.draftApproval,
          conversationHistory: s.conversationHistory,
        })
        cursor = seq
      }

      // Subscribe FIRST, then push initial replay — avoids any window where a
      // frame fires between snapshot and listener registration.
      stream.on("frame", push)
      push()
      const hb = setInterval(heartbeat, 15_000)

      const abort = () => {
        if (closed) return
        closed = true
        clearInterval(hb)
        stream.off("frame", push)
        try { controller.close() } catch {}
      }
      signal.addEventListener("abort", abort, { once: true })
    },
  })

  return new Response(body, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    },
  })
}

export async function pushAgentMessage(sessionId: string, body: any): Promise<OkResponse> {
  const session = loadSession(sessionId)
  if (!session) throw new ApiError(404, "Session not found")
  if (session.status === "thinking" || session.status === "tool-calling") {
    throw new ApiError(409, "Agent is still processing")
  }

  const message = body?.message as string
  if (!message) throw new ApiError(400, "message is required")
  const conversationHistory = normalizeConversationHistory(body?.history, message)
  logSessionEvent({
    source: "authoring.agent",
    event: "user-message",
    sessionId,
    jigId: session.jigId,
    message,
    conversationHistory,
    waitingForToolCallId: session.pendingAskToolCallId,
  })

  session.events.push({ type: "user-message", content: message })

  // If the agent was waiting for an ask_user reply, inject the answer as a tool result
  const pendingToolCallId = session.pendingAskToolCallId
  if (pendingToolCallId) {
    setSessionConversationHistory(session, conversationHistory, message)
    session.pendingAskToolCallId = undefined
    session.pendingAskQuestion = undefined
    session.messages.push({ role: "tool", tool_call_id: pendingToolCallId, content: message })
  } else {
    session.draftApproval = undefined
    setSessionConversationHistory(session, conversationHistory, message)
    const { prompt, authoringPolicy } = await buildAgentSystemPromptWithCode(
      session.authoringIntent,
      session.jigId,
      getDraftCode(session) ?? undefined,
    )
    session.authoringPolicy = authoringPolicy
    session.messages[0] = { role: "system", content: prompt }
    session.messages.push({ role: "user", content: message })
  }
  setSessionStatus(session, "thinking")
  persistSession(session)

  runAgentLoop(session).catch((error) => {
    if (isSessionClosed(session)) return
    setSessionStatus(session, "error")
    session.events.push({ type: "text", content: error?.message ?? String(error) })
    persistSession(session)
    logSessionEvent({
      source: "authoring.agent",
      event: "fatal-error",
      sessionId: session.sessionId,
      jigId: session.jigId,
      error,
    })
  })

  return { ok: true }
}

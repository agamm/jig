import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import OpenAI from "openai"
import type { ChatCompletionContentPart, ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
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
  deleteJig as storeDeleteJig,
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

// Circuit breaker for identical failing tool calls (the write→check→same-write
// death spiral). Warn the model after 2 identical failures, refuse the call
// after 5. Keyed on the raw serialized arguments — the spiral we're breaking is
// verbatim retries. In-memory only; a restart resets the counters, which is fine.
const IDENTICAL_FAILURE_WARN_AT = 2
const IDENTICAL_FAILURE_BLOCK_AT = 5
const failedCallCounts = new WeakMap<AgentSession, Map<string, number>>()

function callSignature(toolCall: { function: { name: string; arguments: string } }): string {
  return `${toolCall.function.name}:${createHash("sha256").update(toolCall.function.arguments).digest("hex").slice(0, 16)}`
}

function countFailedCall(session: AgentSession, signature: string): number {
  let counts = failedCallCounts.get(session)
  if (!counts) failedCallCounts.set(session, (counts = new Map()))
  const n = (counts.get(signature) ?? 0) + 1
  counts.set(signature, n)
  return n
}

/** One template for warn and block — deliberately says nothing about WHY the
 * call fails (open-ended space); it only pushes the model off verbatim retries. */
function retryGuardrailNote(failures: number): string {
  return `This exact call has failed ${failures} times. Do not retry it unchanged — change the arguments or approach, or explain the blocker.`
}

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

  // A creation draft is only reachable through its session. Once the session
  // is gone, a never-approved jig row would orphan the claimed id — invisible
  // in the UI but blocking the name, so the next attempt at the same request
  // errors "Jig already exists" and the agent invents a duplicate variant.
  if (session.creationMode && session.jigId) {
    const row = storeGetJigRow(session.jigId)
    if (row && row.active_version_id == null && !jigHasActiveSession(session.jigId)) {
      storeDeleteJig(session.jigId)
      invalidateJigsCache()
    }
  }
}

/**
 * Returns true if no other live session is editing this jig — caller is safe to claim.
 * v12: lock lives entirely in agent_sessions status; pending in the store is durable
 * across sessions, but only one session can be actively writing at a time.
 */
function releaseStaleJigLock(jigId: string): boolean {
  // Evict expired sessions FIRST. A session stuck in an active status (hung
  // LLM call, abandoned repair/edit) otherwise holds this jig's lock forever:
  // startAgentSession throws its 409 before its own prune call ever runs, so
  // the TTL never got a chance to clear the blocker.
  pruneAgentSessions()
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
  // Text-only by design — images can't ride the flattened intent string. They
  // only reach the model through buildConversationMessages.
  if (history.length === 0) return ""
  return history
    .map((turn) => `${turn.role === "assistant" ? "Assistant" : "User"}: ${turn.content}`)
    .join("\n\n")
}

/** Keep only well-formed image data: URLs from an untrusted request body. */
function normalizeImages(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((x): x is string => typeof x === "string" && x.startsWith("data:image/"))
}

/**
 * Build the `content` for a user message. With images, emit OpenRouter's
 * multimodal array (text part + one image_url part per data: URL); without,
 * keep it a plain string exactly as before.
 */
function buildUserMessageContent(text: string, images?: string[]): string | ChatCompletionContentPart[] {
  if (!images?.length) return text
  return [
    { type: "text", text },
    ...images.map((url): ChatCompletionContentPart => ({ type: "image_url", image_url: { url } })),
  ]
}

/**
 * Return a copy of `history` with `images` attached to its last user turn, so
 * buildConversationMessages emits multimodal content for that turn. Non-mutating
 * — the stored conversationHistory stays text-only (images live in session.messages).
 */
function attachImagesToLastUserTurn(history: AgentConversationTurn[], images: string[]): AgentConversationTurn[] {
  if (!images.length) return history
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role !== "user") continue
    const copy = history.slice()
    copy[i] = { ...copy[i], images }
    return copy
  }
  return history
}

function buildConversationMessages(history: AgentConversationTurn[]): ChatCompletionMessageParam[] {
  return history.map((turn): ChatCompletionMessageParam => {
    if (turn.role === "user" && turn.images?.length) {
      return { role: "user", content: buildUserMessageContent(turn.content, turn.images) }
    }
    return { role: turn.role, content: turn.content }
  })
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
      name: "introspect_tool_output",
      description: "Run a chosen MCP tool live and return a compact shape descriptor of its output (keys, types, array lengths, short value samples — never the full data). Use this AFTER you've decided which tool to call, to learn the real response shape before writing unwrap code. Avoids the common 'result.items || result.messages || []' guess that silently collapses to empty when the actual key is something else. Refuses non-read-only tools unless allowWrite:true is set. Returns `reason:\"response_truncated\"` if the args cause a Composio spill (>~10k inline tokens) — in that case shrink the args (drop verbose/include_payload, lower max_results to ~3, or paginate) and re-introspect. The result may also include `warnings: [...]` flagging \"…N more items\" sentinel strings; if you see those, the inline data was truncated and you MUST adjust args before writing code.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Connection/server key, e.g. workspace, granola, apify, composio" },
          tool: { type: "string", description: "MCP tool name (use the same name shown in the cached schema, e.g. gmail_fetch_emails)" },
          args: { type: "object", description: "Arguments to pass to the tool. Use realistic values — Composio's GMAIL_FETCH_EMAILS for example needs a query/max_results to return anything meaningful.", additionalProperties: true },
          allowWrite: { type: "boolean", description: "Set to true only when probing a non-read-only tool is safe (e.g. a test webhook, or a delete operation against a known-disposable record). Default false." },
        },
        required: ["server", "tool"],
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

export function findDisconnectedImports(code: string): string[] {
  const servers = getImportedServers(code)
  return servers.filter((server) => !existsSync(join(SCHEMAS_DIR, `${server}.json`)))
}

/** True if an authoring session is actively editing this jig. */
export function isJigBeingEdited(jigId: string): boolean {
  return activeAgentJigs.has(jigId)
}

function rewriteJigIdentifier(code: string, newJigId: string): string {
  let replaced = false
  return code.replace(/jig\(\s*(["'`])([^"'`]+)\1/, (match, quote: string) => {
    if (replaced) return match
    replaced = true
    return `jig(${quote}${newJigId}${quote}`
  })
}

async function toolIntrospectToolOutput(args: {
  server?: string
  tool?: string
  args?: Record<string, unknown>
  allowWrite?: boolean
}): Promise<string> {
  const server = args.server?.trim()
  const tool = args.tool?.trim()
  if (!server || !/^[a-zA-Z0-9_-]+$/.test(server)) {
    return JSON.stringify({ ok: false, error: "Invalid server name" })
  }
  if (!tool || !/^[A-Za-z0-9_]+$/.test(tool)) {
    return JSON.stringify({ ok: false, error: "Invalid tool name" })
  }
  const timeout = new Promise<string>((_, reject) =>
    setTimeout(() => reject(new Error("introspect_tool_output timed out after 60s")), 60_000)
  )
  try {
    const { introspectToolOutput } = await import("./introspect.js")
    const result = await Promise.race([
      timeout,
      introspectToolOutput({
        server,
        tool,
        args: args.args ?? {},
        allowWrite: args.allowWrite === true,
      }).then((r) => JSON.stringify(r)),
    ])
    return result
  } catch (e: any) {
    return JSON.stringify({ ok: false, error: e?.message ?? String(e) })
  }
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
  // SSRF guard: reject loopback/private/link-local/metadata targets before the
  // headless browser fetches them — otherwise a prompt-injected URL like
  // http://169.254.169.254/... could pull cloud-metadata/IAM creds into context.
  try {
    const { assertPublicUrl } = await import("../net/ssrf.js")
    await assertPublicUrl(url)
  } catch (e: any) {
    return JSON.stringify({ error: `Refused to browse ${url}: ${e?.message ?? "blocked address"}. Only public http(s) URLs are allowed.` })
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
    case "introspect_tool_output": return toolIntrospectToolOutput(args as any)
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
      unavailableConnections: authoring.unavailableImports,
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

/**
 * Promote a jig's pending version to active and auto-approve its declared
 * tools. The durable core of approval — it needs only the jigId and the
 * pending code, no live authoring session — so an emailed "apply" can ship a
 * valid fix even after its repair session was pruned or released. Returns
 * false when there is no pending version. Callers that ship without a human
 * eyeballing the diff (autoApproveSession, email apply) must validate first.
 */
export async function approvePendingByJig(jigId: string): Promise<boolean> {
  const pending = storeGetPending(jigId)
  if (!pending) return false

  // v12: promote pending to active in one atomic store call. No filesystem
  // writes, no git commits — the version row already holds the code, we just
  // move the active pointer.
  storeApprovePending(jigId)

  // Auto-approve every tool declared by the approved code, whether this is a
  // create or an edit. Sourced from the materialized active version so the
  // behavior is symmetric across flows (the old code path only ran for
  // creation, leaving edit-introduced tools waiting in the tool-review UI).
  try {
    const materialized = await materializeActiveVersion(jigId)
    if (materialized) {
      const introspected = await buildDraftJigResponse(jigId, pending.code, materialized.path, false)
      for (const tool of introspected.settings.tools ?? []) {
        setToolPermission(tool.connection, tool.name, "always")
      }
    }
  } catch {
    // Tool introspection is best-effort; failing it should not block approval.
  }

  invalidateJigsCache()
  activeAgentJigs.delete(jigId)
  return true
}

async function approveDraft(session: AgentSession): Promise<void> {
  if (!session.jigId) throw new ApiError(409, "No pending draft approval")
  if (!(await approvePendingByJig(session.jigId))) throw new ApiError(409, "No pending draft approval")

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

const HEAL_SYSTEM_PROMPT = `You are a repair pass for "jig" workflow files (TypeScript). A jig the authoring agent produced failed validation. You are given the user's intent, the exact validation error, and the current file.

Return the COMPLETE corrected TypeScript file and NOTHING else — no prose, no explanation, no markdown fences.

Rules:
- Make the SMALLEST change that resolves the validation error while honoring the user's intent.
- Preserve the jig() structure and keep every agent()/ctx.output() call inside a ctx.step().
- Never import a connection that isn't set up. If the error indicates a connection is unavailable, remove its usage and rely on an available one consistent with the intent.
- Keep all working logic intact.`

/** Strip a leading/trailing ```ts fence some models add despite instructions. */
function stripCodeFence(raw: string): string {
  const fenced = raw.match(/```(?:ts|typescript)?\s*([\s\S]*?)```/)
  return (fenced ? fenced[1] : raw).trim()
}

type HealResult = { healed: boolean; error: string | null }

/** Parse a tool's JSON result and return its `error` field, if any. */
function toolResultError(result: string): string | undefined {
  try {
    return JSON.parse(result)?.error
  } catch {
    return undefined
  }
}

/**
 * Self-heal: one focused LLM repair call after the authoring agent fails to
 * converge to a passing check. Given the broken code + exact validation error +
 * user intent, ask for a corrected file, write it, and re-check. Heals only if
 * the rewrite passes; otherwise restores the agent's last version so we never
 * leave a different-but-still-broken file behind. Returns the latest validation
 * error so the caller can report it without re-running the check.
 */
async function healJig(session: AgentSession, round: number): Promise<HealResult> {
  const jigId = session.jigId
  if (!jigId) return { healed: false, error: null }
  const code = await getSessionCode(session, jigId)
  if (!code) return { healed: false, error: null }
  const error = await toolCheckJig({}, session)
  if (error === "ok") return { healed: false, error: null } // nothing to heal

  setSessionStatus(session, "thinking")
  session.events.push({ type: "text", content: "Edit didn't pass validation — attempting an automatic fix…" })
  persistSession(session)
  logSessionEvent({ source: "authoring.agent", event: "heal-start", sessionId: session.sessionId, jigId, round, error })

  let fixed: string
  try {
    const resp = await getAgentClient().chat.completions.create({
      model: getEditorModel(),
      max_tokens: 16384,
      messages: [
        { role: "system", content: HEAL_SYSTEM_PROMPT },
        { role: "user", content: `User intent:\n${session.authoringIntent || "(edit this jig)"}\n\nValidation error:\n${error}\n\nCurrent jig file:\n${code}` },
      ],
    })
    if (stopIfClosed(session)) return { healed: false, error }
    fixed = stripCodeFence(resp.choices[0]?.message?.content ?? "")
  } catch (e: any) {
    logSessionEvent({ source: "authoring.agent", event: "heal-error", sessionId: session.sessionId, jigId, round, error: e?.message ?? String(e) })
    return { healed: false, error }
  }

  if (!fixed || fixed === code.trim()) {
    logSessionEvent({ source: "authoring.agent", event: "heal-noop", sessionId: session.sessionId, jigId, round })
    return { healed: false, error }
  }

  const writeErr = toolResultError(await toolWriteJigFile({ code: fixed, jigId }, session))
  if (writeErr) {
    await toolWriteJigFile({ code, jigId }, session) // restore agent's version
    logSessionEvent({ source: "authoring.agent", event: "heal-failed", sessionId: session.sessionId, jigId, round, error: writeErr })
    return { healed: false, error }
  }

  const recheck = await toolCheckJig({}, session)
  if (recheck === "ok") {
    logSessionEvent({ source: "authoring.agent", event: "heal-done", sessionId: session.sessionId, jigId, round })
    return { healed: true, error: null }
  }

  await toolWriteJigFile({ code, jigId }, session) // restore agent's version
  logSessionEvent({ source: "authoring.agent", event: "heal-failed", sessionId: session.sessionId, jigId, round, error: recheck })
  return { healed: false, error: recheck }
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

      const signature = callSignature(toolCall)
      const priorFailures = failedCallCounts.get(session)?.get(signature) ?? 0
      if (priorFailures >= IDENTICAL_FAILURE_BLOCK_AT) {
        const blocked = `Blocked: ${retryGuardrailNote(priorFailures)}`
        session.events.push({ type: "tool-call", tool: toolCall.function.name, args, status: "error", result: blocked })
        session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify({ error: blocked }) })
        roundHadToolError = true
        persistSession(session)
        logSessionEvent({
          source: "authoring.agent",
          event: "tool-blocked",
          sessionId: session.sessionId,
          jigId: session.jigId,
          round,
          tool: toolCall.function.name,
          args,
          failures: priorFailures,
        })
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
        const failures = countFailedCall(session, signature)
        const payload: Record<string, unknown> = { error: e?.message }
        if (failures >= IDENTICAL_FAILURE_WARN_AT) payload.note = retryGuardrailNote(failures)
        session.messages.push({ role: "tool", tool_call_id: toolCall.id, content: JSON.stringify(payload) })
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

  // The agent didn't converge to a passing check within its rounds. Try one
  // focused repair pass before giving up.
  const heal = await healJig(session, MAX_AGENT_ROUNDS)
  if (heal.healed) {
    if (stopIfClosed(session)) return
    if (session.creationMode && getDraftCode(session)) {
      session.draftApproval = await buildDraftApproval(session)
      session.events.push({
        type: "text",
        content: `Draft ready (auto-fixed). Approve to create ${session.jigId}, or reply with changes to revise it.`,
      })
      setSessionStatus(session, "waiting")
    } else {
      session.events.push({
        type: "text",
        content: `Auto-fixed ${session.jigId ?? "the jig"} and it passed the jig check.`,
      })
      setSessionStatus(session, "done")
    }
    persistSession(session)
    logSessionEvent({
      source: "authoring.agent",
      event: "done",
      sessionId: session.sessionId,
      jigId: session.jigId,
      reason: "healed",
    })
    return
  }

  session.events.push({
    type: "text",
    content: heal.error
      ? `Couldn't finish the edit automatically. Last validation error:\n${heal.error}`
      : "Agent reached maximum rounds.",
  })
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
  // Pasted images attach to the latest user turn for the model input only; the
  // stored conversationHistory stays text-only (avoids re-streaming data URLs).
  const images = normalizeImages(body?.images)
  const messagesHistory = attachImagesToLastUserTurn(conversationHistory, images)
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
      ...buildConversationMessages(messagesHistory),
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

/**
 * Subscribe to a session's frame stream — the callback fires whenever session
 * state changes (same signal the SSE handler uses). Returns an unsubscribe fn.
 * Used by the email bridge to react to a session's progress out-of-band.
 */
export function subscribeToSessionFrames(sessionId: string, cb: () => void): () => void {
  const stream = getSessionStream(sessionId)
  const handler = () => cb()
  stream.on("frame", handler)
  return () => stream.off("frame", handler)
}

/**
 * Approve whatever pending version a session produced, for either a creation
 * (draft approval) or an edit (pending diff) — both promote the same way via
 * approveDraft. Returns false if there's nothing to approve, or if the pending
 * doesn't pass the jig check. Used by the email bridge to auto-approve edits
 * made by reply, where there's no human review of the diff.
 *
 * The validation gate matters: the agent can settle into "done" via the
 * max-rounds/heal-failed path while a *broken* last write is still pending.
 * Without a human to eyeball the diff, we re-run the check before shipping.
 */
export async function autoApproveSession(sessionId: string): Promise<boolean> {
  const session = loadSession(sessionId)
  if (!session?.jigId) return false
  if (!(await validatePendingFix(session.jigId))) return false

  await approveDraft(session)
  return true
}

/**
 * A pending version exists, materializes, and passes the jig check. The gate
 * shared by autoApproveSession (before shipping) and the propose-mode email
 * bridge (before emailing a diff) — a broken pending never reaches either.
 */
export async function validatePendingFix(jigId: string): Promise<boolean> {
  if (!storeGetPending(jigId)) return false
  const materialized = await materializePendingVersion(jigId)
  if (!materialized) return false
  return (await checkJigFile(materialized.path)) === "ok"
}

/**
 * Most recent open session that could own the jig's pending version — used to
 * route an emailed "apply" that landed on a different thread than the proposal
 * (e.g. the owner replied to the failure notice instead). Question-waiting
 * sessions are excluded: a "yes" there answers the question, not an approval.
 */
export function findApprovableSessionForJig(jigId: string): string | null {
  for (const row of listAgentSessions()) {
    if (row.jig_id !== jigId || row.pending_ask_tool_call_id) continue
    if (row.status !== "waiting" && row.status !== "done") continue
    if (closedAgentSessions.has(row.session_id)) continue
    return row.session_id
  }
  return null
}

export async function closeAgentSession(sessionId: string): Promise<OkResponse> {
  const session = loadSession(sessionId)
  if (!session) return { ok: true }
  releaseSession(session)
  return { ok: true }
}

/**
 * Where the SSE cursor should advance to after emitting a frame. Tool-call
 * events are mutated in place when they settle (running → done/error), so the
 * cursor must not move past one that's still running — the next frame then
 * re-sends it with its final status. The client merges re-sent slices by
 * absolute index via totalEvents, so re-delivery is idempotent.
 */
export function nextStreamCursor(events: AgentEvent[], cursor: number): number {
  for (let i = cursor; i < events.length; i++) {
    const ev = events[i]
    if (ev.type === "tool-call" && ev.status === "running") return i
  }
  return events.length
}

/**
 * Server-Sent Events stream of agent session updates. Each frame is the
 * AgentStatusResponse shape with only new events since the client's cursor.
 *
 * Frame format: `id: <seq>\nevent: snapshot\ndata: <json>\n\n` where seq is
 * the cursor position after this frame (events.length, unless held back at a
 * still-running tool call). Clients pass Last-Event-ID on reconnect to skip
 * already-seen events.
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
        const next = nextStreamCursor(s.events, cursor)
        send(next, {
          status: s.status,
          jigId: s.jigId,
          events: s.events.slice(cursor),
          totalEvents: seq,
          metrics: s.metrics,
          draftApproval: s.draftApproval,
          conversationHistory: s.conversationHistory,
        })
        cursor = next
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
  const images = normalizeImages(body?.images)
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
    session.messages.push({ role: "user", content: buildUserMessageContent(message, images) })
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

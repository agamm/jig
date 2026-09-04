/**
 * Headless jig-editing agent loop.
 *
 * Nothing interactive drives this anymore. Its callers are the email bridge
 * (a reply to a failure email becomes an edit; an ask_user question goes back
 * out as mail and pushAgentMessage feeds the answer in as the tool result) and
 * run-repair (background auto-repair after a failure streak). Every session
 * edits an existing jig, so startAgentSession requires a jigId. Coding agents
 * author from outside via `jig edit <id> --file=`.
 */
import { createHash } from "node:crypto"
import { EventEmitter } from "events"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import OpenAI from "openai"
import type { ChatCompletionMessageParam, ChatCompletionTool } from "openai/resources/chat/completions"
import type { AgentConversationTurn, AgentEvent, AgentStatusResponse, OkResponse } from "../../shared/api.js"
import { getMainModel } from "../config/models.js"
import { SCHEMAS_DIR } from "../config/paths.js"
import { isValidJigId } from "../domain/jig-id.js"
import { getImportedServers } from "../domain/source-analysis.js"
import { prettifyId } from "../domain/jig-source.js"
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
import { getOpenRouterApiKey, requireOpenRouterApiKey } from "../config/openrouter.js"
import { fastCompletionMessage, type UrlCitation } from "../config/fast-llm.js"
import { logSessionEvent } from "../debug/session-log.js"
import { buildDraftJigResponse } from "./jig-api.js"
import { getConnectionStatus } from "./connection-status.js"
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
  jigId: string
  authoringIntent: string
  conversationHistory: AgentConversationTurn[]
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
const closedAgentSessions = new Set<string>()

// Circuit breaker for identical failing tool calls (the write→check→same-write
// death spiral). Warn the model after 2 identical failures, refuse the call
// after 5. Keyed on the raw serialized arguments - the spiral we're breaking is
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

/** One template for warn and block - deliberately says nothing about WHY the
 * call fails (open-ended space); it only pushes the model off verbatim retries. */
function retryGuardrailNote(failures: number): string {
  return `This exact call has failed ${failures} times. Do not retry it unchanged - change the arguments or approach, or explain the blocker.`
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
    jig_id: session.jigId,
    authoring_intent: session.authoringIntent,
    conversation_history: JSON.stringify(session.conversationHistory),
    authoring_policy: JSON.stringify(session.authoringPolicy),
    messages: JSON.stringify(session.messages),
    events: JSON.stringify(session.events),
    status: session.status,
    created_at: session.createdAt,
    updated_at: Date.now(),
    pending_ask_tool_call_id: session.pendingAskToolCallId ?? null,
    pending_ask_question: session.pendingAskQuestion ?? null,
    // Columns the interactive creation flow used; the table still requires them.
    creation_mode: 0,
    metrics: "{}",
    draft_approval: null,
    last_event_seq: 0,
  }
}

/** Null for rows the old creation flow left without a jig; nothing can resume those. */
function hydrateSession(row: AgentSessionRow): AgentSession | null {
  if (!row.jig_id) return null
  return {
    sessionId: row.session_id,
    jigId: row.jig_id,
    authoringIntent: row.authoring_intent,
    conversationHistory: parseJson<AgentConversationTurn[]>(row.conversation_history, []),
    authoringPolicy: parseJson<AgentSession["authoringPolicy"]>(row.authoring_policy, {
      requiresIntegration: false,
      buildResolutions: [],
    }),
    messages: parseJson<ChatCompletionMessageParam[]>(row.messages, []),
    events: parseJson<AgentEvent[]>(row.events, []),
    status: row.status as AgentSession["status"],
    createdAt: row.created_at,
    pendingAskToolCallId: row.pending_ask_tool_call_id ?? undefined,
    pendingAskQuestion: row.pending_ask_question ?? undefined,
  }
}

function persistSession(session: AgentSession): void {
  if (closedAgentSessions.has(session.sessionId)) return
  upsertAgentSession(serializeSession(session))
  notifySessionStream(session.sessionId)
}

// ---------------------------------------------------------------------------
// Frame bus: one EventEmitter per session, fired after every persistSession so
// out-of-band watchers (the email bridge) can react to progress.
// ---------------------------------------------------------------------------
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

function notifySessionStream(sessionId: string): void {
  sessionStreams.get(sessionId)?.emit("frame")
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
  activeAgentJigs.delete(session.jigId)
  return true
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
  session.status = "waiting"
  persistSession(session)
  return session
}

function loadSession(sessionId: string): AgentSession | null {
  if (closedAgentSessions.has(sessionId)) return null
  const existing = agentSessions.get(sessionId)
  if (existing) return existing
  const row = getAgentSession(sessionId)
  if (!row) return null
  const hydrated = hydrateSession(row)
  if (!hydrated) return null
  const session = markInterruptedIfNeeded(hydrated)
  agentSessions.set(session.sessionId, session)
  if (session.status !== "done" && session.status !== "error") {
    activeAgentJigs.add(session.jigId)
  }
  return session
}

function getSessionCode(session: AgentSession): string | null {
  // Prefer pending (agent is mid-edit), else the active version. Both live in
  // the store; there is no filesystem fallback. The boot-time migration is
  // the only path that imports legacy jigs/*.ts files.
  return storeGetPending(session.jigId)?.code ?? storeGetActiveCode(session.jigId)
}

function releaseSession(session: AgentSession): void {
  closedAgentSessions.add(session.sessionId)
  activeAgentJigs.delete(session.jigId)
  agentSessions.delete(session.sessionId)
  deleteAgentSession(session.sessionId)
  disposeSessionStream(session.sessionId)
}

/**
 * Force-close every session holding this jig, regardless of status. Used when
 * an explicit user edit supersedes whatever is running (hung edit, background
 * repair). releaseSession marks the session closed, so its agent loop exits
 * at the next checkpoint instead of writing into the taken-over jig.
 */
function forceReleaseJigSessions(jigId: string, reason: string): void {
  for (const session of [...agentSessions.values()]) {
    if (session.jigId !== jigId) continue
    logSessionEvent({
      source: "authoring.agent",
      event: "session-superseded",
      sessionId: session.sessionId,
      jigId,
      reason,
    })
    releaseSession(session)
  }
  activeAgentJigs.delete(jigId)
}

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
  // O(1) indexed lookup - does any live session claim this jig?
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
      // v12: don't touch pending here - it's durable across sessions and the
      // next session that opens this jig can pick it up. Only prune the session
      // row itself; the pending stays.
      activeAgentJigs.delete(session.jigId)
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
  return history.map((turn): ChatCompletionMessageParam => ({ role: turn.role, content: turn.content }))
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
      description: "Read the current source code of the session's jig.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "write_jig_file",
      description: "Write the complete TypeScript source of the session's jig. The write is staged as a pending version until approved.",
      parameters: {
        type: "object",
        properties: {
          code: { type: "string", description: "The complete TypeScript source code" },
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
      description: "Run TypeScript compiler and jig validator on the session's jig. Returns errors or 'ok'.",
      parameters: { type: "object", properties: {} },
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
      description: "Ask the user a question and wait for their response. Use this to collect information needed to write the jig - e.g. their email address, team name, Slack channel, or any other constant that should be hardcoded. The agent loop pauses until the user replies.",
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
      description: "Run a chosen MCP tool live and return a compact shape descriptor of its output (keys, types, array lengths, short value samples - never the full data). Use this AFTER you've decided which tool to call, to learn the real response shape before writing unwrap code. Avoids the common 'result.items || result.messages || []' guess that silently collapses to empty when the actual key is something else. Refuses non-read-only tools unless allowWrite:true is set. Returns `reason:\"response_truncated\"` if the args cause a Composio spill (>~10k inline tokens) - in that case shrink the args (drop verbose/include_payload, lower max_results to ~3, or paginate) and re-introspect. The result may also include `warnings: [...]` flagging \"…N more items\" sentinel strings; if you see those, the inline data was truncated and you MUST adjust args before writing code.",
      parameters: {
        type: "object",
        properties: {
          server: { type: "string", description: "Connection/server key, e.g. workspace, granola, apify, composio" },
          tool: { type: "string", description: "MCP tool name (use the same name shown in the cached schema, e.g. gmail_fetch_emails)" },
          args: { type: "object", description: "Arguments to pass to the tool. Use realistic values - Composio's GMAIL_FETCH_EMAILS for example needs a query/max_results to return anything meaningful.", additionalProperties: true },
          allowWrite: { type: "boolean", description: "Set to true only when probing a non-read-only tool is safe (e.g. a test webhook, or a delete operation against a known-disposable record). Default false." },
        },
        required: ["server", "tool"],
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

function toolReadJigFile(session: AgentSession): string {
  return getSessionCode(session) ?? JSON.stringify({ error: `File not found for jig: ${session.jigId}` })
}

function toolWriteJigFile(args: { code: string; message?: string }, session: AgentSession): string {
  const disconnected = findDisconnectedImports(args.code)
  if (disconnected.length > 0) {
    return JSON.stringify({
      error: `Code imports unconnected servers: ${disconnected.join(", ")}. Either ask the user to run 'jig connect <server>' and wait, or rewrite the jig to not depend on those servers.`,
      disconnectedServers: disconnected,
    })
  }

  // v12: every write goes to pending. Approve promotes.
  const { versionId } = storeWritePending({
    jigId: session.jigId,
    name: prettifyId(session.jigId),
    code: args.code,
    author: "agent",
    message: args.message ?? null,
    prompt: session.authoringIntent || null,
  })

  // A broken connection isn't fixable by editing the jig, so this warns rather
  // than blocks - but it must never be silent: shipping a jig onto a schedule
  // against a dead connection is how a failure gets discovered at 8am instead
  // of now.
  const unhealthy = findUnhealthyImports(args.code)
  return JSON.stringify({
    ok: true,
    pendingVersionId: versionId,
    draft: true,
    ...(unhealthy.length > 0 && {
      warning:
        `Saved, but ${unhealthy.map((u) => `"${u.server}" is ${u.state}`).join("; ")}. ` +
        `This jig will fail at runtime until that is resolved. Tell the user plainly: which connection is broken, ` +
        `the reason if known, and that they need to reconnect it from the dashboard Connections page before relying on this jig.`,
      unhealthyConnections: unhealthy,
    }),
  })
}

async function toolCheckJig(session: AgentSession): Promise<string> {
  const jigId = session.jigId
  const code = getSessionCode(session)
  if (!code) return JSON.stringify({ error: `File not found for jig: ${jigId}` })

  // Check whichever version is currently the source of truth - pending if
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
  // identifier inside every version's code atomically - no follow-up needed.
  storeRenameJig(oldJigId, newJigId)
  renameJigLocalState(oldJigId, newJigId)
  activeAgentJigs.delete(oldJigId)
  activeAgentJigs.add(newJigId)
  session.jigId = newJigId
  persistSession(session)
  return JSON.stringify({ ok: true, oldJigId, newJigId, draft: storeGetPending(newJigId) != null })
}

export function findDisconnectedImports(code: string): string[] {
  const servers = getImportedServers(code)
  return servers.filter((server) => !existsSync(join(SCHEMAS_DIR, `${server}.json`)))
}

/**
 * Imported connections that are set up but known to be broken.
 *
 * findDisconnectedImports only answers "was this ever connected" (is there a
 * schema file on disk) - a connection whose credentials were later revoked, or
 * whose server stopped answering, still passes it. That's how a jig gets
 * authored against a dead connection and only fails on its first scheduled
 * run. Runtime records health at the MCP chokepoints (connection-status.ts),
 * so consult it before the agent commits code.
 */
export function findUnhealthyImports(code: string): { server: string; state: string; detail?: string }[] {
  const unhealthy: { server: string; state: string; detail?: string }[] = []
  for (const server of getImportedServers(code)) {
    // Not-set-up servers are already reported by findDisconnectedImports.
    if (!existsSync(join(SCHEMAS_DIR, `${server}.json`))) continue
    const status = getConnectionStatus(server)
    if (status && status.state !== "ok") {
      unhealthy.push({ server, state: status.state, ...(status.detail ? { detail: status.detail } : {}) })
    }
  }
  return unhealthy
}

/** True if an authoring session is actively editing this jig. */
export function isJigBeingEdited(jigId: string): boolean {
  return activeAgentJigs.has(jigId)
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

/**
 * Web search via OpenRouter's built-in web plugin.
 *
 * The previous implementation scraped google.com/search through the headless
 * browser. That never worked: Google answers datacenter and automation traffic
 * with a reCAPTCHA "unusual traffic" page, so the agent got a CAPTCHA instead
 * of results. OpenRouter runs the search server-side (native provider search
 * where available, else Exa) and returns url_citation annotations, so there is
 * no browser, no bot-detection, and it works headless in the container.
 */
async function toolWebSearch(args: { query: string }): Promise<string> {
  const query = args.query?.trim()
  if (!query) return JSON.stringify({ error: "query is required" })
  if (!getOpenRouterApiKey()) {
    return JSON.stringify({ error: "No OpenRouter API key configured - web search is unavailable." })
  }

  const message = await fastCompletionMessage({
    system: "You search the web and report findings. Summarize what is relevant to the query, and cite sources.",
    user: `Search the web for: ${query}`,
    maxTokens: 1200,
    timeoutMs: 60_000,
    body: { plugins: [{ id: "web", max_results: 5 }] },
  })

  // Hand the citation list back with the summary so claims remain traceable.
  const sources = (message?.annotations ?? [])
    .map((a) => a.url_citation)
    .filter((c): c is UrlCitation => !!c?.url)
    .map((c) => ({ url: c.url, title: c.title, excerpt: c.content?.slice(0, 500) }))
  const summary = message?.content?.trim()
  if (!summary && sources.length === 0) return JSON.stringify({ error: "Web search returned no results." })
  return JSON.stringify({ summary, sources })
}

const ASK_USER_SENTINEL = "__ASK_USER__"

async function executeAgentTool(name: string, args: Record<string, any>, session: AgentSession): Promise<string> {
  switch (name) {
    case "read_jig_file": return toolReadJigFile(session)
    case "write_jig_file": return toolWriteJigFile(args as any, session)
    case "check_jig": return toolCheckJig(session)
    case "get_tool_schema": return toolGetToolSchema(args as any)
    case "introspect_tool_output": return toolIntrospectToolOutput(args as any)
    case "rename_jig": return toolRenameJig(args as any, session)
    case "ask_user": return ASK_USER_SENTINEL
    case "web_search": return toolWebSearch(args as any)
    default: return JSON.stringify({ error: `Unknown tool: ${name}` })
  }
}

async function buildAgentSystemPrompt(
  instruction: string,
  jigId: string,
  currentCode?: string
): Promise<{
  prompt: string
  authoringPolicy: AgentSession["authoringPolicy"]
}> {
  const code = currentCode || (storeGetPending(jigId)?.code ?? storeGetActiveCode(jigId) ?? "")

  let authoring
  try {
    authoring = await buildAuthoringState(instruction, { existingCode: code })
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
      currentCode: code,
      exampleJig: authoring.context.exampleJig,
      unavailableConnections: authoring.unavailableImports,
    }),
    authoringPolicy: {
      requiresIntegration: authoring.requiresIntegration || authoring.allServers.length > 0,
      buildResolutions: authoring.buildResolutions,
    },
  }
}

/**
 * Promote a jig's pending version to active and auto-approve its declared
 * tools. The durable core of approval - it needs only the jigId and the
 * pending code, no live authoring session - so an emailed "apply" can ship a
 * valid fix even after its repair session was pruned or released. Returns
 * false when there is no pending version. Callers that ship without a human
 * eyeballing the diff (autoApproveSession, email apply) must validate first.
 */
export async function approvePendingByJig(jigId: string): Promise<boolean> {
  const pending = storeGetPending(jigId)
  if (!pending) return false

  // v12: promote pending to active in one atomic store call. No filesystem
  // writes, no git commits - the version row already holds the code, we just
  // move the active pointer.
  storeApprovePending(jigId)

  // Auto-approve every tool declared by the approved code, sourced from the
  // materialized active version so edit-introduced tools don't wait in the
  // tool-review UI.
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

  activeAgentJigs.delete(jigId)
  return true
}

async function approveDraft(session: AgentSession): Promise<void> {
  if (!(await approvePendingByJig(session.jigId))) throw new ApiError(409, "No pending draft approval")

  deleteAgentSession(session.sessionId)
  session.events.push({ type: "text", content: `Approved changes to ${session.jigId}.` })
  session.status = "done"
  logSessionEvent({
    source: "authoring.agent",
    event: "draft-approved",
    sessionId: session.sessionId,
    jigId: session.jigId,
  })
}

const HEAL_SYSTEM_PROMPT = `You are a repair pass for "jig" workflow files (TypeScript). A jig the authoring agent produced failed validation. You are given the user's intent, the exact validation error, and the current file.

Return the COMPLETE corrected TypeScript file and NOTHING else - no prose, no explanation, no markdown fences.

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
  const code = getSessionCode(session)
  if (!code) return { healed: false, error: null }
  const error = await toolCheckJig(session)
  if (error === "ok") return { healed: false, error: null } // nothing to heal

  session.status = "thinking"
  session.events.push({ type: "text", content: "Edit didn't pass validation - attempting an automatic fix…" })
  persistSession(session)
  logSessionEvent({ source: "authoring.agent", event: "heal-start", sessionId: session.sessionId, jigId, round, error })

  let fixed: string
  try {
    const resp = await getAgentClient().chat.completions.create({
      model: getMainModel(),
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

  const writeErr = toolResultError(toolWriteJigFile({ code: fixed }, session))
  if (writeErr) {
    toolWriteJigFile({ code }, session) // restore agent's version
    logSessionEvent({ source: "authoring.agent", event: "heal-failed", sessionId: session.sessionId, jigId, round, error: writeErr })
    return { healed: false, error }
  }

  const recheck = await toolCheckJig(session)
  if (recheck === "ok") {
    logSessionEvent({ source: "authoring.agent", event: "heal-done", sessionId: session.sessionId, jigId, round })
    return { healed: true, error: null }
  }

  toolWriteJigFile({ code }, session) // restore agent's version
  logSessionEvent({ source: "authoring.agent", event: "heal-failed", sessionId: session.sessionId, jigId, round, error: recheck })
  return { healed: false, error: recheck }
}

async function runAgentLoop(session: AgentSession): Promise<void> {
  const client = getAgentClient()

  let consecutiveErrors = 0
  for (let round = 0; round < MAX_AGENT_ROUNDS; round++) {
    if (stopIfClosed(session)) return
    session.status = "thinking"
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
        model: getMainModel(),
        messages: session.messages,
        tools: AGENT_TOOL_DEFS,
      })
      response = await client.chat.completions.create({
        model: getMainModel(),
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
        model: getMainModel(),
        error: e,
      })
      consecutiveErrors++
      const msg = e?.message ?? String(e)
      if (consecutiveErrors >= 3) {
        session.events.push({ type: "text", content: `Failed after ${consecutiveErrors} retries: ${msg}` })
        session.status = "error"
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
      session.status = "error"
      persistSession(session)
      logSessionEvent({
        source: "authoring.agent",
        event: "empty-response",
        sessionId: session.sessionId,
        jigId: session.jigId,
        round,
        model: getMainModel(),
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
      model: getMainModel(),
      message: msg,
      finishReason: response.choices[0]?.finish_reason,
      usage: response.usage,
    })

    session.messages.push(msg as ChatCompletionMessageParam)
    persistSession(session)

    if (!msg.tool_calls?.length) {
      session.events.push({ type: "text", content: msg.content ?? "" })
      session.status = "done"
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

    session.status = "tool-calling"
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
    let pendingAsk: { toolCallId: string; question: string } | null = null
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
          pendingAsk = { toolCallId: toolCall.id, question }
          persistSession(session)
          continue
        }

        event.status = "done"
        event.result = result
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
      session.status = "waiting"
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
      session.events.push({ type: "text", content: `Updated ${session.jigId} and it passed the jig check.` })
      session.status = "done"
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
    session.events.push({ type: "text", content: `Auto-fixed ${session.jigId} and it passed the jig check.` })
    session.status = "done"
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
  session.status = "done"
  persistSession(session)
  logSessionEvent({
    source: "authoring.agent",
    event: "done",
    sessionId: session.sessionId,
    jigId: session.jigId,
    reason: "max-rounds",
  })
}

/** Fire-and-forget the loop; a thrown error becomes the session's terminal state. */
function launchAgentLoop(session: AgentSession): void {
  runAgentLoop(session).catch((error) => {
    if (isSessionClosed(session)) return
    session.status = "error"
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
}

export async function startAgentSession(body: any): Promise<{ sessionId: string; jigId: string }> {
  const instruction = body?.instruction as string
  if (!instruction) throw new ApiError(400, "instruction is required")

  const jigId = body?.jigId as string | undefined
  if (!jigId) throw new ApiError(400, "jigId is required")
  if (!isValidJigId(jigId)) throw new ApiError(400, "Invalid jig ID")
  // "repair" = background auto-repair; anything else is an explicit user edit.
  const origin = body?.origin === "repair" ? "repair" : "user"

  if (!releaseStaleJigLock(jigId)) {
    if (origin === "repair") {
      // Background repair never steals the jig from a live session.
      throw new ApiError(409, "An agent session is already editing this jig")
    }
    // Single-owner system: an explicit user edit always wins over whatever
    // holds the lock (a hung edit, a background repair session).
    forceReleaseJigSessions(jigId, "superseded by a new user edit session")
  }

  const conversationHistory = normalizeConversationHistory(body?.history, instruction)
  const authoringIntent = renderConversationIntent(conversationHistory) || instruction
  const sessionId = crypto.randomUUID()
  closedAgentSessions.delete(sessionId)
  const { prompt: systemPrompt, authoringPolicy } = await buildAgentSystemPrompt(authoringIntent, jigId)

  const session: AgentSession = {
    sessionId,
    jigId,
    authoringIntent,
    conversationHistory,
    authoringPolicy,
    messages: [
      { role: "system", content: systemPrompt },
      ...buildConversationMessages(conversationHistory),
    ],
    events: [],
    status: "thinking",
    createdAt: Date.now(),
  }

  pruneAgentSessions()
  agentSessions.set(sessionId, session)
  activeAgentJigs.add(jigId)
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

  launchAgentLoop(session)
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
    conversationHistory: session.conversationHistory,
  }
}

/**
 * Subscribe to a session's frame stream; the callback fires whenever session
 * state changes. Returns an unsubscribe fn. Used by the email bridge to react
 * to a session's progress out-of-band.
 */
export function subscribeToSessionFrames(sessionId: string, cb: () => void): () => void {
  const stream = getSessionStream(sessionId)
  const handler = () => cb()
  stream.on("frame", handler)
  return () => stream.off("frame", handler)
}

/**
 * Approve the pending version a session produced. Returns false if there's
 * nothing to approve, or if the pending doesn't pass the jig check. Used by
 * the email bridge to auto-approve edits made by reply, where there's no human
 * review of the diff.
 *
 * The validation gate matters: the agent can settle into "done" via the
 * max-rounds/heal-failed path while a *broken* last write is still pending.
 * Without a human to eyeball the diff, we re-run the check before shipping.
 */
export async function autoApproveSession(sessionId: string): Promise<boolean> {
  const session = loadSession(sessionId)
  if (!session) return false
  if (!(await validatePendingFix(session.jigId))) return false

  await approveDraft(session)
  return true
}

/**
 * A pending version exists, materializes, and passes the jig check. The gate
 * shared by autoApproveSession (before shipping) and the propose-mode email
 * bridge (before emailing a diff) - a broken pending never reaches either.
 */
export async function validatePendingFix(jigId: string): Promise<boolean> {
  if (!storeGetPending(jigId)) return false
  const materialized = await materializePendingVersion(jigId)
  if (!materialized) return false
  return (await checkJigFile(materialized.path)) === "ok"
}

/**
 * Most recent open session that could own the jig's pending version - used to
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
  setSessionConversationHistory(session, conversationHistory, message)

  // If the agent was waiting for an ask_user reply, inject the answer as a tool result
  const pendingToolCallId = session.pendingAskToolCallId
  if (pendingToolCallId) {
    session.pendingAskToolCallId = undefined
    session.pendingAskQuestion = undefined
    session.messages.push({ role: "tool", tool_call_id: pendingToolCallId, content: message })
  } else {
    const { prompt, authoringPolicy } = await buildAgentSystemPrompt(
      session.authoringIntent,
      session.jigId,
      storeGetPending(session.jigId)?.code,
    )
    session.authoringPolicy = authoringPolicy
    session.messages[0] = { role: "system", content: prompt }
    session.messages.push({ role: "user", content: message })
  }
  session.status = "thinking"
  persistSession(session)

  launchAgentLoop(session)
  return { ok: true }
}

export type JigHealth = "healthy" | "attention" | "failed"
export type RunOutcomeStatus = "success" | "fail"
export type LiveStepStatus = "running" | "success" | "fail" | "healed"

export interface JigStepTool {
  connection: string
  name: string
  readOnly: boolean
}

export interface JigStep {
  num: number
  name: string
  connections?: string[]
  tools?: JigStepTool[]
}

export interface JigRunStep {
  label: string
  time: string
  cost?: string
  tag?: string
  healed?: boolean
  output?: string
}

export interface JigRun {
  date: string
  duration: string
  status: RunOutcomeStatus
  cost: string
  output?: string
  /** Failure message for failed runs (so the UI can show why, not "no output"). */
  error?: string
  steps?: JigRunStep[]
}

export interface JigTool {
  connection: string
  name: string
  readOnly: boolean
}

export type ToolPermissionPolicy = "always" | "ask" | "never"

export interface ToolPermission {
  connection: string
  tool: string
  policy: ToolPermissionPolicy
}

export interface ScheduleInfo {
  triggerType: "cron" | "webhook"
  cronExpr: string | null
  timezone?: string | null
  missedStrategy: "catch-up" | "skip"
  nextRunAt: string | null
  lastRunAt: string | null
  enabled: boolean
  error: string | null
  webhookUrl?: string
}

export interface UnderConstructionInfo {
  sessionId: string
  jigId?: string
  status: AgentStatus
  updatedAt: string
}

export interface JigData {
  id: string
  name: string
  trigger: string
  status: JigHealth
  underConstruction?: UnderConstructionInfo
  running?: boolean
  sparkline: number[]
  steps: JigStep[]
  code: string
  runs: JigRun[]
  schedule?: ScheduleInfo
  settings: {
    trigger: string
    connections: string[]
    tools?: JigTool[]
    permissions: ToolPermission[]
  }
  /** Dashboard model override (OpenRouter id). null = use jig code / global default. */
  modelOverride?: string | null
  /** Model the jig's source code declares as default (via `jig(id, {model:"..."}, ...)`). */
  modelInCode?: string | null
  /** Dashboard per-step model overrides keyed by step seq (1-indexed) as a string. */
  stepModelOverrides?: Record<string, string>
  /** Per-jig run watchdog override in ms; null = global default. */
  runTimeoutMs?: number | null
  /** Per-jig MCP tool-call timeout override in ms; null = global default. */
  toolTimeoutMs?: number | null
  costMonth?: string
  costLifetime?: string
}

export type ConnectionStatusState = "ok" | "auth-required" | "unreachable"

/** Last observed runtime health of a connection, written at MCP failure chokepoints. */
export interface ConnectionStatusInfo {
  state: ConnectionStatusState
  detail?: string
  at: string
}

export interface Connection {
  name: string
  connected: boolean
  toolCount: number
  description: string
  custom?: boolean
  /** If set, tools are proxied through this meta-tool (e.g. COMPOSIO_MULTI_EXECUTE_TOOL) */
  proxyVia?: string
  /** URL to provider's dashboard for adding more connections (only set for proxy connections) */
  proxyDashboardUrl?: string
  /** Runtime health (token expired, unreachable). null/absent = no signal recorded. */
  status?: ConnectionStatusInfo | null
  /** A detached connect (OAuth in flight) is still running server-side. */
  connectInProgress?: boolean
}

export interface ConnectionTool {
  name: string
  description: string
  readOnly: boolean
  destructive: boolean
}

export interface ConnectionDetail extends Connection {
  tools: ConnectionTool[]
  usedBy: string[]
}

export interface ExampleJig {
  id: string
  name: string
  trigger: string
  description: string
  connections: string[]
  steps: JigStep[]
}

export type ConnectConnectionResponse =
  | {
      ok: true
      server: string
      toolCount: number
      tools: string[]
    }
  | {
      ok: false
      server: string
      missingCredentials: string[]
      setup?: string
    }
  | {
      // Service-mode (Railway/Render/Fly) OAuth flow. The connection is still
      // running on the server waiting for the callback — the dashboard opens
      // the URL in a new tab and polls /api/connections/:name until it flips
      // to connected.
      ok: false
      awaitingOAuth: true
      server: string
      authorizationUrl: string
      /** Local mode auto-opens the browser server-side — dashboard shouldn't re-open. */
      browserOpened?: boolean
    }

export interface DisconnectConnectionResponse {
  ok: true
  server: string
  removed: { credentials: boolean; schema: boolean; connection: boolean }
}

export interface CreateCustomConnectionResponse {
  ok: true
  connection: Connection
}

export interface OkResponse {
  ok: true
}

export interface ModelInfo {
  id: string
  label: string
}

export interface ModelCatalog {
  main: ModelInfo
  editor: ModelInfo
  fast: ModelInfo
  defaults?: {
    main: ModelInfo
    editor: ModelInfo
    fast: ModelInfo
  }
}

export interface OpenRouterModelInfo {
  id: string
  name: string
  description?: string
  contextLength: number
  promptPriceUsdPerM: number
  completionPriceUsdPerM: number
  blendedPriceUsdPerM: number
  supportsTools: boolean
  supportsReasoning: boolean
  /** Whether the model accepts image input (multimodal). Derived from OpenRouter's input_modalities. */
  supportsImages: boolean
  createdAt: number
  rank: number
  /** p50 time-to-first-token (ms) from the fastest live endpoint. Only populated for upgrade suggestions. */
  latencyMs?: number
  /** p50 output throughput (tokens/sec). Only populated for upgrade suggestions. */
  throughputTps?: number
}

export interface OpenRouterCatalogResponse {
  models: OpenRouterModelInfo[]
  fetchedAt: number
}

export interface ModelUpgradeSuggestion {
  slot: ModelSlot
  current: OpenRouterModelInfo
  suggested: OpenRouterModelInfo
  // Human-readable reason: "newer • 38% cheaper • rank 12 → 8"
  reason: string
  // Counts of jigs that explicitly reference the *current* model id. Override
  // and step counts are auto-updatable on approval; code refs need a manual
  // source edit and are surfaced read-only.
  overrideRefCount: number
  stepRefCount: number
  codeRefCount: number
}

export interface ModelUpgradesResponse {
  suggestions: ModelUpgradeSuggestion[]
  fetchedAt: number
}

export interface ApplyModelUpgradeRequest {
  slot: ModelSlot
  modelId: string
  updateJigs: boolean
}

export interface ApplyModelUpgradeResponse {
  ok: true
  slot: ModelSlot
  modelId: string
  jigsUpdated: number
}

export interface DismissModelUpgradeRequest {
  slot: ModelSlot
  modelId: string
}

export interface DataStorageHealth {
  ok: boolean
  path: string
  mounted: boolean
  writable: boolean
  persistent: boolean
  message?: string
  action?: string
}

export const MODEL_SLOTS = ["main", "editor", "fast"] as const
export type ModelSlot = (typeof MODEL_SLOTS)[number]

export interface ModelOverrideInput {
  main?: string
  editor?: string
  fast?: string
}

export interface AgentConversationTurn {
  role: "user" | "assistant"
  content: string
  /** Pasted image data: URLs attached to a user turn (multimodal input). Only rides through to
   * the LLM via buildConversationMessages; stripped from history round-trips and intent rendering. */
  images?: string[]
}

export type AgentEvent =
  | {
      type: "tool-call"
      tool: string
      args: Record<string, unknown>
      status: "running" | "done" | "error"
      result?: string
    }
  | {
      type: "text"
      content: string
    }
  | {
      type: "user-message"
      content: string
    }

export type AgentStatus = "thinking" | "tool-calling" | "waiting" | "done" | "error" | "idle"

export interface AgentMetrics {
  model?: string
  round?: number
  activeTool?: string
  activeStartedAt?: number
  estimatedPromptTokens?: number
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  updatedAt?: number
}

export interface AgentDraftApproval {
  jig: JigData
}

export interface StartAgentResponse {
  sessionId: string
  jigId?: string
}

export interface AgentStatusResponse {
  status: AgentStatus
  jigId?: string
  events: AgentEvent[]
  totalEvents: number
  metrics?: AgentMetrics
  draftApproval?: AgentDraftApproval
  conversationHistory?: AgentConversationTurn[]
}

export interface LiveRunStep {
  seq: number
  label: string
  status: LiveStepStatus
  output?: string
  connections?: string[]
  durationMs?: number
  error?: string
}

export interface RunStatus {
  active: boolean
  runId?: number
  jigId?: string
  dryRun?: boolean
  startedAt?: number
  completedTools: string[]
  activeTools: string[]
  steps: LiveRunStep[]
  readOnly?: Record<string, boolean>
  error?: string
  output?: string
  status?: "running" | "success" | "fail"
}

export interface StartRunResponse {
  runId: number
  jigId: string
  dryRun: boolean
}

export interface RunDetailStep {
  label: string
  time: string
  status: LiveStepStatus
  output?: string | null
  error?: string | null
  healed?: boolean
  connections?: string[]
}

export interface RunDetail {
  id: number
  jigId: string
  startedAt: string | null
  finishedAt: string | null
  status: "running" | "success" | "fail"
  durationMs: number | null
  error: string | null
  completedTools: string[]
  activeTools: string[]
  readOnly?: Record<string, boolean>
  output?: string | null
  steps: RunDetailStep[]
}

export interface StepList {
  steps: JigStep[]
}

export interface TriggerUpdateResponse {
  ok: boolean
  trigger: string
  warning?: string
}

export interface ResetLocalStateResponse {
  ok: true
  deletedJigs: string[]
  disconnectedConnections?: string[]
}

export interface AddExampleJigResponse {
  ok: true
  jigId: string
}

export interface DeleteJigResponse {
  ok: true
  jigId: string
}

// ---------------------------------------------------------------------------
// v12: code-as-versions API contracts.
// ---------------------------------------------------------------------------

export type JigVersionAuthor = "agent" | "restore" | "import" | "cli"

export interface JigVersionRecord {
  id: number
  jigId: string
  author: JigVersionAuthor
  message: string | null
  prompt: string | null
  parentVersionId: number | null
  createdAt: number
}

export interface JigVersionListResponse {
  active: JigVersionRecord | null
  pending: JigVersionRecord | null
  history: JigVersionRecord[]
}

/** Returned by GET /api/jigs/:id/pending when a pending change exists. */
export interface PendingState {
  versionId: number
  code: string
  publishedCode: string
  diff: string
  addedLines: number
  removedLines: number
  author: JigVersionAuthor
  prompt: string | null
  message: string | null
  createdAt: number
}

export interface ApprovePendingResponse {
  ok: true
  jigId: string
  activeVersionId: number
}

export interface DiscardPendingResponse {
  ok: true
  jigId: string
}

export interface RestoreToPendingRequest {
  versionId: number
}

export interface RestoreToPendingResponse {
  ok: true
  jigId: string
  pendingVersionId: number
}

export interface CancelRunResponse {
  ok: true
  jigId: string
}

export interface ScheduleListItem extends ScheduleInfo {
  jigId: string
}

export interface UpdateScheduleRequest {
  enabled: boolean
}

export interface SystemSettings {
  timezone: string
}

export interface AuthorizedSender {
  channel: string
  sender_id: string
  authorized_at: string
}

export interface ServerLogEntry {
  seq: number
  ts: number
  level: "info" | "warn" | "error"
  source?: string
  msg: string
  /**
   * Redacted JSON payload for structured (session-log) events — LLM prompts/
   * responses, tool args/results, agent rounds. NULL for plain console.log
   * lines. Rendered behind an expander in the dashboard Logs view.
   */
  payload?: string | null
}

export interface ServerLogsResponse {
  entries: ServerLogEntry[]
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

export interface NotificationCapableTool {
  connection: string
  tool: string
  label: string
  description: string
  textField: string
  recipientField: string
  extraRequired: string[]
}

export interface NotificationChannel {
  connection: string
  tool: string
  recipient: string
  extraParams?: Record<string, unknown>
}

export interface NotificationSettings {
  channels: NotificationChannel[]
  triggerOn: { fail: boolean }
}

export interface NotificationHealth {
  ok: boolean
  severity: "success" | "danger"
  reasons: string[]
}

export interface NotificationTestStatus {
  at: string
  ok: boolean
  sent: number
  errors: number
}

export interface NotificationSettingsResponse {
  settings: NotificationSettings
  availableTools: NotificationCapableTool[]
  health: NotificationHealth
  testStatus: NotificationTestStatus | null
}

export interface NotifyTestResponse {
  sent: Array<{ channel: string; ok: true }>
  errors: Array<{ channel: string; error: string }>
}

export interface SchedulerHealth {
  running: boolean
  /** ISO timestamp of the last completed scheduler loop, null before first tick. */
  lastTickAt: string | null
}

export interface HealthResponse {
  version: string
  mode: "service" | "local"
  public_url: string | null
  locked: boolean
  password_set: boolean
  /** Service mode + no password yet: the setup form must collect the one-time
   * setup code printed in the server logs before it can claim the instance. */
  setup_code_required?: boolean
  onboarding_complete: boolean
  has_openrouter_key?: boolean
  uptime_s?: number
  data_storage?: DataStorageHealth
  scheduler?: SchedulerHealth
  /** Can the API server write to SQLite right now? */
  db_writable?: boolean
  /** Runs stuck in 'running' for over 2 hours — should be 0 with run timeouts on. */
  stalled_runs?: number
  /** Whether the repliable AgentMail failure-alert channel is set up. */
  agentmail_configured?: boolean
}

// ---------------------------------------------------------------------------
// AgentMail — repliable jig-failure emails (reply to edit the jig)
// ---------------------------------------------------------------------------

export interface AgentMailSettingsResponse {
  /** Fully wired for reply-to-edit: can send AND the inbound webhook is registered. */
  configured: boolean
  /** Can send alerts (key + inbox + owner) — independent of the inbound webhook. */
  canSend: boolean
  /** Whether an API key is stored (key itself is never returned). */
  hasKey: boolean
  /** The provisioned inbox address (e.g. jig-xxxx@agentmail.to), if set up. */
  address: string | null
  /** The sole address allowed to drive edits by reply. */
  owner: string | null
  /** Whether the inbound webhook has been registered (signing secret stored). */
  webhookReady: boolean
}

export interface AgentMailSettingsUpdate {
  apiKey?: string
  owner?: string
}

export interface AgentMailSetupResponse {
  ok: boolean
  address?: string
  /** Whether the inbound reply-to-edit webhook was registered during setup. */
  webhookReady?: boolean
  error?: string
}

export interface AgentMailTestResponse {
  ok: boolean
  error?: string
}

export interface OpenRouterCredits {
  /** Lifetime credits granted to the account (USD). */
  totalCredits: number
  /** Lifetime usage charged against those credits (USD). */
  totalUsage: number
  /** max(0, totalCredits - totalUsage) (USD). */
  remaining: number
  fetchedAt: number
}

export interface ApiContract<Request, Response> {
  request: Request
  response: Response
}

export interface ApiContracts {
  health: ApiContract<void, HealthResponse>
  completeOnboarding: ApiContract<{ openrouter_key?: string }, OkResponse>
  setupPassword: ApiContract<{ password: string; setupCode?: string }, OkResponse>
  unlock: ApiContract<{ password: string }, OkResponse>
  changePassword: ApiContract<{ newPassword: string }, OkResponse>
  models: ApiContract<ModelOverrideInput | void, ModelCatalog>
  modelsCatalog: ApiContract<void, OpenRouterCatalogResponse>
  openrouterCredits: ApiContract<void, OpenRouterCredits | null>
  classifyFailure: ApiContract<{ error: string }, { needsReauth: boolean }>
  modelUpgrades: ApiContract<void, ModelUpgradesResponse>
  applyModelUpgrade: ApiContract<ApplyModelUpgradeRequest, ApplyModelUpgradeResponse>
  dismissModelUpgrade: ApiContract<DismissModelUpgradeRequest, OkResponse>
  listJigs: ApiContract<void, JigData[]>
  listExamples: ApiContract<void, ExampleJig[]>
  addExample: ApiContract<void, AddExampleJigResponse>
  getJig: ApiContract<void, JigData>
  deleteJig: ApiContract<void, DeleteJigResponse>
  runJig: ApiContract<{ dryRun: boolean }, StartRunResponse>
  writeJigCode: ApiContract<{ code: string; message?: string; approve?: boolean }, { ok: true; pendingVersionId: number; activeVersionId: number | null }>
  updateJigModel: ApiContract<{ model: string | null }, { ok: true; jigId: string; model: string | null }>
  updateJigTimeouts: ApiContract<{ runTimeoutMs?: number | null; toolTimeoutMs?: number | null }, { ok: true; jigId: string; runTimeoutMs: number | null; toolTimeoutMs: number | null }>
  updateJigStepModel: ApiContract<{ seq: number; model: string | null }, { ok: true; jigId: string; seq: number; model: string | null }>
  getRun: ApiContract<void, RunDetail>
  activeRun: ApiContract<void, RunStatus>
  cancelRun: ApiContract<{ jigId?: string }, CancelRunResponse>
  connections: ApiContract<void, Connection[]>
  createCustomConnection: ApiContract<{ name: string; url: string; description?: string }, CreateCustomConnectionResponse>
  getConnection: ApiContract<void, ConnectionDetail>
  connectConnection: ApiContract<{ credentials?: Record<string, string> }, ConnectConnectionResponse>
  disconnectConnection: ApiContract<void, DisconnectConnectionResponse>
  getSteps: ApiContract<void, StepList>
  updateTrigger: ApiContract<{ trigger: string }, TriggerUpdateResponse>
  startAgent: ApiContract<{ instruction: string; jigId?: string; history?: AgentConversationTurn[]; images?: string[] }, StartAgentResponse>
  agentStatus: ApiContract<void, AgentStatusResponse>
  agentMessage: ApiContract<{ message: string; history?: AgentConversationTurn[]; images?: string[] }, OkResponse>
  agentApprove: ApiContract<void, OkResponse>
  agentClose: ApiContract<void, OkResponse>
  // v12 — code-as-versions endpoints
  getPending: ApiContract<void, PendingState | null>
  approvePending: ApiContract<void, ApprovePendingResponse>
  discardPending: ApiContract<void, DiscardPendingResponse>
  restoreToPending: ApiContract<RestoreToPendingRequest, RestoreToPendingResponse>
  listVersionsV2: ApiContract<void, JigVersionListResponse>
  listSchedules: ApiContract<void, ScheduleListItem[]>
  updateSchedule: ApiContract<UpdateScheduleRequest, OkResponse>
  systemSettings: ApiContract<SystemSettings | void, SystemSettings>
  authorizedSenders: ApiContract<void, AuthorizedSender[]>
  addAuthorizedSender: ApiContract<{ channel: string; sender_id: string }, OkResponse>
  deleteAuthorizedSender: ApiContract<void, OkResponse>
  notificationSettings: ApiContract<NotificationSettings | void, NotificationSettingsResponse>
  notificationSettingsTest: ApiContract<void, NotifyTestResponse>
  agentMailSettings: ApiContract<AgentMailSettingsUpdate | void, AgentMailSettingsResponse>
  agentMailSetup: ApiContract<void, AgentMailSetupResponse>
  agentMailTest: ApiContract<void, AgentMailTestResponse>
  toolPermissions: ApiContract<void, ToolPermission[]>
  saveToolPermission: ApiContract<{ connection: string; tool: string; policy: ToolPermissionPolicy }, OkResponse>
  resetLocalState: ApiContract<void, ResetLocalStateResponse>
  serverLogs: ApiContract<void, ServerLogsResponse>
  clearServerLogs: ApiContract<void, OkResponse>
}

export type ApiEndpointKey = keyof ApiContracts
export type ApiRequest<K extends ApiEndpointKey> = ApiContracts[K]["request"]
export type ApiResponse<K extends ApiEndpointKey> = ApiContracts[K]["response"]

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
  missedStrategy: "catch-up" | "skip"
  nextRunAt: string | null
  lastRunAt: string | null
  enabled: boolean
  error: string | null
  webhookUrl?: string
}

export interface JigData {
  id: string
  name: string
  trigger: string
  status: JigHealth
  running?: boolean
  sparkline: number[]
  steps: JigStep[]
  params?: Record<string, string>
  code: string
  runs: JigRun[]
  schedule?: ScheduleInfo
  settings: {
    trigger: string
    connections: string[]
    tools?: JigTool[]
    permissions: ToolPermission[]
  }
  costMonth?: string
  costLifetime?: string
}

export interface Connection {
  name: string
  connected: boolean
  toolCount: number
  description: string
  /** If set, tools are proxied through this meta-tool (e.g. COMPOSIO_MULTI_EXECUTE_TOOL) */
  proxyVia?: string
  /** URL to provider's dashboard for adding more connections (only set for proxy connections) */
  proxyDashboardUrl?: string
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

export interface ModelInfo {
  id: string
  label: string
}

export interface ModelCatalog {
  main: ModelInfo
  editor: ModelInfo
  fast: ModelInfo
}

export interface AgentConversationTurn {
  role: "user" | "assistant"
  content: string
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

export type AgentStatus = "thinking" | "tool-calling" | "waiting" | "done" | "error" | "idle"

export interface AgentMetrics {
  model?: string
  round?: number
  activeTool?: string
  promptTokens?: number
  completionTokens?: number
  totalTokens?: number
  updatedAt?: number
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

export interface JigVersion {
  sha: string
  date: string
  message: string
}

export interface JigVersionDetail {
  sha: string
  code: string
  diff: string
  hasChanges: boolean
  prompt?: string | null
}

export interface RestoreJigVersionResult {
  ok: true
  sha: string
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

export interface NotificationSettingsResponse {
  settings: NotificationSettings
  availableTools: NotificationCapableTool[]
}

export interface NotifyTestResponse {
  sent: Array<{ channel: string; ok: true }>
  errors: Array<{ channel: string; error: string }>
}

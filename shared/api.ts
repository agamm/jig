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
  steps?: JigRunStep[]
}

export interface JigTool {
  connection: string
  name: string
  readOnly: boolean
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
  needsUpgrade?: boolean
  settings: {
    trigger: string
    connections: string[]
    tools?: JigTool[]
    permissions: string[]
  }
  costMonth?: string
  costLifetime?: string
}

export interface Connection {
  name: string
  connected: boolean
  toolCount: number
  description: string
}

export interface ConnectionTool {
  name: string
  description: string
  readOnly: boolean
}

export interface ConnectionDetail extends Connection {
  tools: ConnectionTool[]
  usedBy: string[]
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

export interface StartAgentResponse {
  sessionId: string
  jigId?: string
}

export interface AgentStatusResponse {
  status: AgentStatus
  jigId?: string
  events: AgentEvent[]
  totalEvents: number
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

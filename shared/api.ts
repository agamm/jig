export type JigHealth = "healthy" | "attention" | "failed"
export type RunOutcomeStatus = "success" | "fail"
export type LiveStepStatus = "running" | "success" | "fail" | "healed"

export interface JigStepDto {
  num: number
  name: string
  connections?: string[]
}

export interface JigRunStepDto {
  label: string
  time: string
  cost?: string
  tag?: string
  healed?: boolean
  output?: string
}

export interface JigRunDto {
  date: string
  duration: string
  status: RunOutcomeStatus
  cost: string
  steps?: JigRunStepDto[]
}

export interface JigEntityDto {
  name: string
  lastRun: string
  status: RunOutcomeStatus
}

export interface JigDto {
  id: string
  name: string
  trigger: string
  status: JigHealth
  running?: boolean
  grouped?: boolean
  entityCount?: number
  entities?: JigEntityDto[]
  sparkline: number[]
  steps: JigStepDto[]
  params?: Record<string, string>
  code: string
  runs: JigRunDto[]
  settings: {
    trigger: string
    connections: string[]
    permissions: string[]
  }
  costMonth?: string
  costLifetime?: string
}

export interface ConnectionDto {
  name: string
  connected: boolean
  toolCount: number
  description: string
}

export interface ConnectionToolDto {
  name: string
  description: string
  readOnly: boolean
}

export interface ConnectionDetailDto extends ConnectionDto {
  tools: ConnectionToolDto[]
  usedBy: string[]
}

export interface ModelInfoDto {
  id: string
  label: string
}

export interface ModelsDto {
  main: ModelInfoDto
  editor: ModelInfoDto
  fast: ModelInfoDto
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

export interface StartAgentResponseDto {
  sessionId: string
  jigId?: string
}

export interface AgentStatusResponseDto {
  status: AgentStatus
  jigId?: string
  events: AgentEvent[]
  totalEvents: number
}

export interface LiveRunStepDto {
  seq: number
  label: string
  status: LiveStepStatus
  output?: string
  connections?: string[]
  durationMs?: number
  error?: string
}

export interface RunStatusDto {
  active: boolean
  runId?: number
  jigId?: string
  entity?: string | null
  dryRun?: boolean
  completedTools: string[]
  activeTools: string[]
  steps: LiveRunStepDto[]
  readOnly?: Record<string, boolean>
  error?: string
  output?: string
  status?: "running" | "success" | "fail"
}

export interface StartRunResponseDto {
  runId: number
  jigId: string
  entity?: string | null
  dryRun: boolean
}

export interface RunDetailStepDto {
  label: string
  time: string
  status: LiveStepStatus
  output?: string | null
  error?: string | null
  healed?: boolean
  connections?: string[]
}

export interface RunDetailDto {
  id: number
  jigId: string
  entity: string | null
  startedAt: string | null
  finishedAt: string | null
  status: "running" | "success" | "fail"
  durationMs: number | null
  error: string | null
  completedTools: string[]
  activeTools: string[]
  readOnly?: Record<string, boolean>
  steps: RunDetailStepDto[]
}

export interface StepListDto {
  steps: JigStepDto[]
}

export interface TriggerUpdateResponseDto {
  ok: boolean
  trigger: string
  warning?: string
}

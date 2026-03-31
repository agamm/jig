import type {
  AgentStatusResponseDto,
  ConnectionDetailDto,
  ConnectionDto,
  JigDto,
  ModelsDto,
  RunDetailDto,
  RunStatusDto,
  StartAgentResponseDto,
  StartRunResponseDto,
  StepListDto,
  TriggerUpdateResponseDto,
} from "@shared/api"

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(error.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function fetchJigs(): Promise<JigDto[]> {
  return fetchJson("/api/jigs")
}

export function fetchJig(jigId: string, entity?: string | null): Promise<JigDto> {
  const search = entity ? `?entity=${encodeURIComponent(entity)}` : ""
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}${search}`)
}

export function deleteJig(jigId: string, entity?: string | null): Promise<{ ok: true }> {
  const search = entity ? `?entity=${encodeURIComponent(entity)}` : ""
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}${search}`, {
    method: "DELETE",
  })
}

export function fetchModels(): Promise<ModelsDto> {
  return fetchJson("/api/models")
}

export function fetchConnections(): Promise<ConnectionDto[]> {
  return fetchJson("/api/connections")
}

export function fetchConnection(name: string): Promise<ConnectionDetailDto> {
  return fetchJson(`/api/connections/${encodeURIComponent(name)}`)
}

export function fetchJigSteps(jigId: string, entity?: string | null): Promise<StepListDto> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}/steps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ entity: entity ?? undefined }),
  })
}

export function updateJigTrigger(jigId: string, trigger: string, entity?: string | null): Promise<TriggerUpdateResponseDto> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger, entity: entity ?? undefined }),
  })
}

export function startAgentSession(instruction: string, jigId?: string, entity?: string): Promise<StartAgentResponseDto> {
  return fetchJson("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, jigId, entity }),
  })
}

export function fetchAgentStatus(sessionId: string, since = 0): Promise<AgentStatusResponseDto> {
  return fetchJson(`/api/agent/${sessionId}?since=${since}`)
}

export function sendAgentMessage(sessionId: string, message: string): Promise<{ ok: true }> {
  return fetchJson(`/api/agent/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message }),
  })
}

export function startJigRun(jigId: string, payload: {
  entity?: string
  dryRun: boolean
  params?: Record<string, string>
}): Promise<StartRunResponseDto> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

export function fetchRunStatus(runId: number): Promise<RunDetailDto> {
  return fetchJson(`/api/runs/${runId}`)
}

export function fetchActiveRun(): Promise<RunStatusDto> {
  return fetchJson("/api/runs/active")
}

export function cancelActiveRun(): Promise<{ ok: true; runId: number }> {
  return fetchJson("/api/runs/cancel", { method: "POST" })
}

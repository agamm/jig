import type {
  AgentStatusResponse,
  Connection,
  ConnectionDetail,
  JigData,
  JigVersionDetail,
  JigVersion,
  ModelCatalog,
  RestoreJigVersionResult,
  RunDetail,
  RunStatus,
  StartAgentResponse,
  StartRunResponse,
  StepList,
  TriggerUpdateResponse,
} from "@shared/api"

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
    throw new Error(error.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function fetchJigs(): Promise<JigData[]> {
  return fetchJson("/api/jigs")
}

export function fetchJig(jigId: string): Promise<JigData> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}`)
}

export function deleteJig(jigId: string): Promise<{ ok: true }> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}`, { method: "DELETE" })
}

export function fetchModels(): Promise<ModelCatalog> {
  return fetchJson("/api/models")
}

export function fetchConnections(): Promise<Connection[]> {
  return fetchJson("/api/connections")
}

export function fetchConnection(name: string): Promise<ConnectionDetail> {
  return fetchJson(`/api/connections/${encodeURIComponent(name)}`)
}

export function fetchJigSteps(jigId: string): Promise<StepList> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}/steps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
}

export function updateJigTrigger(jigId: string, trigger: string): Promise<TriggerUpdateResponse> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger }),
  })
}

export function startAgentSession(instruction: string, jigId?: string): Promise<StartAgentResponse> {
  return fetchJson("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, jigId }),
  })
}

export function fetchAgentStatus(sessionId: string, since = 0): Promise<AgentStatusResponse> {
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
  dryRun: boolean
  params?: Record<string, string>
}): Promise<StartRunResponse> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

export function fetchRunStatus(runId: number): Promise<RunDetail> {
  return fetchJson(`/api/runs/${runId}`)
}

export function fetchActiveRun(): Promise<RunStatus> {
  return fetchJson("/api/runs/active")
}

export function cancelActiveRun(): Promise<{ ok: true; runId: number }> {
  return fetchJson("/api/runs/cancel", { method: "POST" })
}

export function fetchJigVersions(jigId: string): Promise<JigVersion[]> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}/versions`)
}

export function fetchJigVersionDetail(jigId: string, sha: string): Promise<JigVersionDetail> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}/versions/${sha}`)
}

export function restoreJigVersion(jigId: string, sha: string): Promise<RestoreJigVersionResult> {
  return fetchJson(`/api/jigs/${encodeURIComponent(jigId)}/versions/${sha}/restore`, {
    method: "POST",
  })
}

import type {
  AddExampleJigResponse,
  AgentStatusResponse,
  AgentConversationTurn,
  Connection,
  ConnectionDetail,
  ConnectConnectionResponse,
  ExampleJig,
  JigData,
  JigVersionDetail,
  JigVersion,
  ModelCatalog,
  NotificationSettings,
  NotificationSettingsResponse,
  NotifyTestResponse,
  RestoreJigVersionResult,
  ResetLocalStateResponse,
  RunDetail,
  RunStatus,
  StartAgentResponse,
  StartRunResponse,
  StepList,
  TriggerUpdateResponse,
  ToolPermission,
  ToolPermissionPolicy,
} from "@shared/api"

async function fetchJson<T>(input: RequestInfo, init?: RequestInit): Promise<T> {
  const res = await fetch(input, init)
  if (!res.ok) {
    const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` })) as {
      error?: string
      details?: Record<string, unknown>
    }
    const wrapped = new Error(error.error ?? `HTTP ${res.status}`) as Error & {
      details?: Record<string, unknown>
    }
    if (error.details) wrapped.details = error.details
    throw wrapped
  }
  return res.json() as Promise<T>
}

export function fetchJigs(): Promise<JigData[]> {
  return fetchJson("/api/jigs")
}

export function fetchExamples(): Promise<ExampleJig[]> {
  return fetchJson("/api/examples")
}

export function addExampleJig(id: string): Promise<AddExampleJigResponse> {
  return fetchJson(`/api/examples/${encodeURIComponent(id)}/add`, { method: "POST" })
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

export function connectConnection(name: string, credentials?: Record<string, string>): Promise<ConnectConnectionResponse> {
  return fetchJson(`/api/connections/${encodeURIComponent(name)}/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials ? { credentials } : {}),
  })
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

export function startAgentSession(
  instruction: string,
  jigId?: string,
  history?: AgentConversationTurn[]
): Promise<StartAgentResponse> {
  return fetchJson("/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, jigId, history }),
  })
}

export function fetchAgentStatus(sessionId: string, since = 0): Promise<AgentStatusResponse> {
  return fetchJson(`/api/agent/${sessionId}?since=${since}`)
}

export function sendAgentMessage(
  sessionId: string,
  message: string,
  history?: AgentConversationTurn[]
): Promise<{ ok: true }> {
  return fetchJson(`/api/agent/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
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

export function fetchActiveRunForJig(jigId: string): Promise<RunStatus> {
  return fetchJson(`/api/runs/active?jigId=${encodeURIComponent(jigId)}`)
}

export function cancelActiveRun(jigId?: string): Promise<{ ok: true; jigId: string }> {
  return fetchJson("/api/runs/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jigId ? { jigId } : {}),
  })
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

export function fetchNotificationSettings(): Promise<NotificationSettingsResponse> {
  return fetchJson("/api/settings/notifications")
}

export function saveNotificationSettings(settings: NotificationSettings): Promise<NotificationSettingsResponse> {
  return fetchJson("/api/settings/notifications", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  })
}

export function sendTestNotification(): Promise<NotifyTestResponse> {
  return fetchJson("/api/settings/notifications/test", { method: "POST" })
}

export function resetLocalState(): Promise<ResetLocalStateResponse> {
  return fetchJson("/api/settings/reset-local", { method: "POST" })
}

export function fetchToolPermissions(): Promise<ToolPermission[]> {
  return fetchJson("/api/permissions")
}

export function saveToolPermission(input: {
  connection: string
  tool: string
  policy: ToolPermissionPolicy
}): Promise<{ ok: true }> {
  return fetchJson("/api/permissions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}

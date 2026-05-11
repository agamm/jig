import type {
  AddExampleJigResponse,
  ApiEndpointKey,
  ApiResponse,
  AgentConversationTurn,
  Connection,
  ConnectionDetail,
  ConnectConnectionResponse,
  CreateCustomConnectionResponse,
  ExampleJig,
  JigData,
  JigVersionDetail,
  JigVersion,
  JigVersionListResponse,
  PendingState,
  ApprovePendingResponse,
  DiscardPendingResponse,
  RestoreToPendingResponse,
  ModelCatalog,
  ModelOverrideInput,
  OpenRouterCatalogResponse,
  NotificationSettings,
  NotificationSettingsResponse,
  NotifyTestResponse,
  RestoreJigVersionResult,
  ResetLocalStateResponse,
  RunDetail,
  RunStatus,
  ServerLogEntry as SharedServerLogEntry,
  StartAgentResponse,
  StartRunResponse,
  StepList,
  SystemSettings,
  TriggerUpdateResponse,
  ToolPermission,
  ToolPermissionPolicy,
  UpdateScheduleRequest,
} from "@shared/api"

export type ServerLogEntry = SharedServerLogEntry

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

function fetchApi<K extends ApiEndpointKey>(contract: K, input: RequestInfo, init?: RequestInit): Promise<ApiResponse<K>> {
  void contract
  return fetchJson<ApiResponse<K>>(input, init)
}

export function fetchJigs(): Promise<JigData[]> {
  return fetchApi("listJigs", "/api/jigs")
}

export function fetchHealth(): Promise<ApiResponse<"health">> {
  return fetchApi("health", "/api/health", { cache: "no-store" })
}

export function completeOnboarding(openrouterKey?: string): Promise<ApiResponse<"completeOnboarding">> {
  return fetchApi("completeOnboarding", "/api/onboarding/complete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(openrouterKey ? { openrouter_key: openrouterKey } : {}),
  })
}

export function setupPassword(password: string): Promise<ApiResponse<"setupPassword">> {
  return fetchApi("setupPassword", "/api/setup-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
}

export function unlock(password: string): Promise<ApiResponse<"unlock">> {
  return fetchApi("unlock", "/api/unlock", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
}

export function fetchExamples(): Promise<ExampleJig[]> {
  return fetchApi("listExamples", "/api/examples")
}

export function addExampleJig(id: string): Promise<AddExampleJigResponse> {
  return fetchApi("addExample", `/api/examples/${encodeURIComponent(id)}/add`, { method: "POST" })
}

export function fetchJig(jigId: string): Promise<JigData> {
  return fetchApi("getJig", `/api/jigs/${encodeURIComponent(jigId)}`)
}

export function deleteJig(jigId: string): Promise<ApiResponse<"deleteJig">> {
  return fetchApi("deleteJig", `/api/jigs/${encodeURIComponent(jigId)}`, { method: "DELETE" })
}

export function fetchModels(): Promise<ModelCatalog> {
  return fetchApi("models", "/api/models")
}

export function updateModels(patch: ModelOverrideInput): Promise<ModelCatalog> {
  return fetchApi("models", "/api/models", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  })
}

export function fetchOpenRouterCatalog(): Promise<OpenRouterCatalogResponse> {
  return fetchApi("modelsCatalog", "/api/models/catalog")
}

export function fetchConnections(): Promise<Connection[]> {
  return fetchApi("connections", "/api/connections")
}

export function fetchConnection(name: string): Promise<ConnectionDetail> {
  return fetchApi("getConnection", `/api/connections/${encodeURIComponent(name)}`)
}

export function connectConnection(
  name: string,
  credentials?: Record<string, string>,
  init?: Pick<RequestInit, "signal">
): Promise<ConnectConnectionResponse> {
  return fetchApi("connectConnection", `/api/connections/${encodeURIComponent(name)}/connect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(credentials ? { credentials } : {}),
    signal: init?.signal,
  })
}

export function disconnectConnection(name: string): Promise<ApiResponse<"disconnectConnection">> {
  return fetchApi("disconnectConnection", `/api/connections/${encodeURIComponent(name)}/disconnect`, { method: "POST" })
}

export function createCustomConnection(input: {
  name: string
  url: string
  description?: string
}): Promise<CreateCustomConnectionResponse> {
  return fetchApi("createCustomConnection", "/api/connections/custom", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}

export function fetchJigSteps(jigId: string): Promise<StepList> {
  return fetchApi("getSteps", `/api/jigs/${encodeURIComponent(jigId)}/steps`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  })
}

export function updateJigTrigger(jigId: string, trigger: string): Promise<TriggerUpdateResponse> {
  return fetchApi("updateTrigger", `/api/jigs/${encodeURIComponent(jigId)}/trigger`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trigger }),
  })
}

export function updateSchedule(jigId: string, input: UpdateScheduleRequest): Promise<ApiResponse<"updateSchedule">> {
  return fetchApi("updateSchedule", `/api/schedules/${encodeURIComponent(jigId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}

export function startAgentSession(
  instruction: string,
  jigId?: string,
  history?: AgentConversationTurn[]
): Promise<StartAgentResponse> {
  return fetchApi("startAgent", "/api/agent", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, jigId, history }),
  })
}

export function sendAgentMessage(
  sessionId: string,
  message: string,
  history?: AgentConversationTurn[]
): Promise<ApiResponse<"agentMessage">> {
  return fetchApi("agentMessage", `/api/agent/${sessionId}/message`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message, history }),
  })
}

export function approveAgentDraft(sessionId: string): Promise<ApiResponse<"agentApprove">> {
  return fetchApi("agentApprove", `/api/agent/${sessionId}/approve`, {
    method: "POST",
  })
}

export function closeAgentSession(sessionId: string): Promise<ApiResponse<"agentClose">> {
  return fetchApi("agentClose", `/api/agent/${sessionId}/close`, {
    method: "DELETE",
  })
}

export function startJigRun(jigId: string, payload: {
  dryRun: boolean
}): Promise<StartRunResponse> {
  return fetchApi("runJig", `/api/jigs/${encodeURIComponent(jigId)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  })
}

export function fetchRunStatus(runId: number): Promise<RunDetail> {
  return fetchApi("getRun", `/api/runs/${runId}`)
}

export function fetchActiveRun(): Promise<RunStatus> {
  return fetchApi("activeRun", "/api/runs/active")
}

export function fetchActiveRunForJig(jigId: string): Promise<RunStatus> {
  return fetchApi("activeRun", `/api/runs/active?jigId=${encodeURIComponent(jigId)}`)
}

export function cancelActiveRun(jigId?: string): Promise<ApiResponse<"cancelRun">> {
  return fetchApi("cancelRun", "/api/runs/cancel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(jigId ? { jigId } : {}),
  })
}

export function fetchJigVersions(jigId: string): Promise<JigVersion[]> {
  return fetchApi("getVersions", `/api/jigs/${encodeURIComponent(jigId)}/versions`)
}

export function fetchJigVersionDetail(jigId: string, sha: string): Promise<JigVersionDetail> {
  return fetchApi("getVersionCode", `/api/jigs/${encodeURIComponent(jigId)}/versions/${sha}`)
}

export function restoreJigVersion(jigId: string, sha: string): Promise<RestoreJigVersionResult> {
  return fetchApi("restoreVersion", `/api/jigs/${encodeURIComponent(jigId)}/versions/${sha}/restore`, {
    method: "POST",
  })
}

// v12: code-as-versions endpoints
export function fetchPending(jigId: string): Promise<PendingState | null> {
  return fetchApi("getPending", `/api/jigs/${encodeURIComponent(jigId)}/pending`)
}

export function approvePending(jigId: string): Promise<ApprovePendingResponse> {
  return fetchApi("approvePending", `/api/jigs/${encodeURIComponent(jigId)}/pending/approve`, { method: "POST" })
}

export function discardPending(jigId: string): Promise<DiscardPendingResponse> {
  return fetchApi("discardPending", `/api/jigs/${encodeURIComponent(jigId)}/pending`, { method: "DELETE" })
}

export function restoreToPending(jigId: string, versionId: number): Promise<RestoreToPendingResponse> {
  return fetchApi("restoreToPending", `/api/jigs/${encodeURIComponent(jigId)}/restore`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ versionId }),
  })
}

export function fetchVersionsV2(jigId: string): Promise<JigVersionListResponse> {
  return fetchApi("listVersionsV2", `/api/jigs/${encodeURIComponent(jigId)}/versions-v2`)
}

export function fetchNotificationSettings(): Promise<NotificationSettingsResponse> {
  return fetchApi("notificationSettings", "/api/settings/notifications")
}

export function saveNotificationSettings(settings: NotificationSettings): Promise<NotificationSettingsResponse> {
  return fetchApi("notificationSettings", "/api/settings/notifications", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  })
}

export function sendTestNotification(): Promise<NotifyTestResponse> {
  return fetchApi("notificationSettingsTest", "/api/settings/notifications/test", { method: "POST" })
}

export function fetchSystemSettings(): Promise<SystemSettings> {
  return fetchApi("systemSettings", "/api/settings/system")
}

export function saveSystemSettings(settings: SystemSettings): Promise<SystemSettings> {
  return fetchApi("systemSettings", "/api/settings/system", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  })
}

export function resetLocalState(): Promise<ResetLocalStateResponse> {
  return fetchApi("resetLocalState", "/api/settings/reset-local", { method: "POST" })
}

export function changePassword(newPassword: string): Promise<ApiResponse<"changePassword">> {
  return fetchApi("changePassword", "/api/change-password", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ newPassword }),
  })
}

export function fetchToolPermissions(): Promise<ToolPermission[]> {
  return fetchApi("toolPermissions", "/api/permissions")
}

export function saveToolPermission(input: {
  connection: string
  tool: string
  policy: ToolPermissionPolicy
}): Promise<ApiResponse<"saveToolPermission">> {
  return fetchApi("saveToolPermission", "/api/permissions", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  })
}

export function fetchServerLogs(since = 0): Promise<ApiResponse<"serverLogs">> {
  const qs = since > 0 ? `?since=${since}` : ""
  return fetchApi("serverLogs", `/api/logs${qs}`)
}

export function clearServerLogs(): Promise<ApiResponse<"clearServerLogs">> {
  return fetchApi("clearServerLogs", "/api/logs", { method: "DELETE" })
}

/** SWR keys and fetchers for jig data. */
import useSWR, { type SWRConfiguration } from "swr"
import { fetchJigs, fetchModels, fetchJigSteps, fetchConnections, fetchConnection, fetchActiveRunForJig, fetchExamples, fetchHealth, fetchSystemSettings, fetchPending, fetchVersionsV2, fetchOpenRouterCredits, fetchOpenRouterCatalog } from "./api"
import type { JigData, ModelCatalog, StepList, Connection, ConnectionDetail, RunStatus, ExampleJig, HealthResponse, SystemSettings, PendingState, JigVersionListResponse, OpenRouterCredits, OpenRouterCatalogResponse } from "@shared/api"

const REFRESH_INTERVAL = 10_000

export function useJigs(config?: SWRConfiguration<JigData[]>) {
  return useSWR<JigData[]>("jigs", fetchJigs, {
    refreshInterval: REFRESH_INTERVAL,
    revalidateOnFocus: true,
    ...config,
  })
}

export function useExamples() {
  return useSWR<ExampleJig[]>("examples", fetchExamples, {
    revalidateOnFocus: false,
  })
}

export function useHealth() {
  return useSWR<HealthResponse>("health", fetchHealth, {
    refreshInterval: REFRESH_INTERVAL,
    revalidateOnFocus: true,
  })
}

export function useModels() {
  return useSWR<ModelCatalog>("models", fetchModels, {
    revalidateOnFocus: false,
  })
}

export function useOpenRouterCatalog() {
  return useSWR<OpenRouterCatalogResponse>("openrouter-catalog", fetchOpenRouterCatalog, {
    revalidateOnFocus: false,
  })
}

export function useOpenRouterCredits() {
  return useSWR<OpenRouterCredits | null>("openrouter-credits", fetchOpenRouterCredits, {
    refreshInterval: 60_000,
    revalidateOnFocus: true,
  })
}

export function useSystemSettings() {
  return useSWR<SystemSettings>("system-settings", fetchSystemSettings, {
    revalidateOnFocus: false,
  })
}

export function useJigSteps(jigId: string | null) {
  return useSWR<StepList>(
    jigId ? `jig/${jigId}/steps` : null,
    () => fetchJigSteps(jigId!),
  )
}

export function useConnections() {
  return useSWR<Connection[]>("connections", fetchConnections, {
    refreshInterval: REFRESH_INTERVAL,
  })
}

export function useConnection(name: string | null) {
  return useSWR<ConnectionDetail>(
    name ? `connection/${name}` : null,
    () => fetchConnection(name!),
  )
}

export function usePending(jigId: string | null, config?: SWRConfiguration<PendingState | null>) {
  return useSWR<PendingState | null>(
    jigId ? `jig/${jigId}/pending` : null,
    () => fetchPending(jigId!),
    {
      // Pending versions arrive out of band (reply-to-email edits, auto-repair,
      // CLI pushes), so poll rather than wait for a UI event.
      refreshInterval: 5000,
      revalidateOnFocus: true,
      ...config,
    },
  )
}

export function useVersionsV2(jigId: string | null) {
  return useSWR<JigVersionListResponse>(
    jigId ? `jig/${jigId}/versions-v2` : null,
    () => fetchVersionsV2(jigId!),
  )
}

/**
 * Detects active runs of this jig that the dashboard didn't start itself
 * (webhook, cron, CLI). Polls every 2s when idle, pauses when the caller
 * has already attached its own poll loop to avoid double-polling.
 */
export function useDetectActiveRun(jigId: string | null, options: { paused?: boolean } = {}) {
  return useSWR<RunStatus>(
    jigId && !options.paused ? `jig/${jigId}/active-run` : null,
    () => fetchActiveRunForJig(jigId!),
    { refreshInterval: 2000, revalidateOnFocus: true }
  )
}

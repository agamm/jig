/** SWR keys and fetchers for jig data. */
import useSWR, { type SWRConfiguration } from "swr"
import { fetchJigs, fetchJig, fetchModels, fetchJigSteps, fetchConnections, fetchConnection, fetchJigVersions, fetchActiveRunForJig, fetchExamples, fetchHealth, fetchSystemSettings, fetchPending, fetchVersionsV2 } from "./api"
import type { JigData, ModelCatalog, StepList, Connection, ConnectionDetail, JigVersion, RunStatus, ExampleJig, HealthResponse, SystemSettings, PendingState, JigVersionListResponse } from "@shared/api"

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

export function useJig(jigId: string | null, config?: SWRConfiguration<JigData>) {
  return useSWR<JigData>(
    jigId ? `jig/${jigId}` : null,
    () => fetchJig(jigId!),
    config
  )
}

export function useModels() {
  return useSWR<ModelCatalog>("models", fetchModels, {
    revalidateOnFocus: false,
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

export function useJigVersions(jigId: string | null) {
  return useSWR<JigVersion[]>(
    jigId ? `jig/${jigId}/versions` : null,
    () => fetchJigVersions(jigId!),
  )
}

export function usePending(jigId: string | null, config?: SWRConfiguration<PendingState | null>) {
  return useSWR<PendingState | null>(
    jigId ? `jig/${jigId}/pending` : null,
    () => fetchPending(jigId!),
    {
      // Pending state changes when the agent writes — caller invalidates this
      // key on tool-call events. Background refresh as a safety net.
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

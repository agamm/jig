/** SWR keys and fetchers for jig data. */
import useSWR, { type SWRConfiguration } from "swr"
import { fetchJigs, fetchJig, fetchModels, fetchJigSteps, fetchConnections, fetchConnection, fetchJigVersions, fetchActiveRunForJig } from "./api"
import type { JigData, ModelCatalog, StepList, Connection, ConnectionDetail, JigVersion, RunStatus } from "@shared/api"

const REFRESH_INTERVAL = 10_000

export function useJigs(config?: SWRConfiguration<JigData[]>) {
  return useSWR<JigData[]>("jigs", fetchJigs, {
    refreshInterval: REFRESH_INTERVAL,
    revalidateOnFocus: true,
    ...config,
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

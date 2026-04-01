/** SWR keys and fetchers for jig data. */
import useSWR, { type SWRConfiguration } from "swr"
import { fetchJigs, fetchJig, fetchModels, fetchJigSteps, fetchConnections } from "./api"
import type { JigData, ModelCatalog, StepList, Connection } from "@shared/api"

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

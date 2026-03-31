"use client"

import { useCallback, useEffect, useRef, useState } from "react"

export function useAsyncResource<T>(
  load: () => Promise<T>,
  deps: unknown[],
  options?: { keepStaleData?: boolean }
) {
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [reloadToken, setReloadToken] = useState(0)
  const reloadResolversRef = useRef<Array<() => void>>([])

  const reload = useCallback(() => (
    new Promise<void>((resolve) => {
      reloadResolversRef.current.push(resolve)
      setReloadToken((value) => value + 1)
    })
  ), [])

  useEffect(() => {
    let cancelled = false
    if (!options?.keepStaleData) setData(null)
    setLoading(true)
    setError(null)

    load()
      .then((next) => {
        if (!cancelled) setData(next)
      })
      .catch((err: any) => {
        if (!cancelled) {
          setError(err?.message ?? "Failed to load")
          if (!options?.keepStaleData) setData(null)
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false)
          const resolvers = reloadResolversRef.current.splice(0)
          resolvers.forEach((resolve) => resolve())
        }
      })

    return () => {
      cancelled = true
    }
  }, [...deps, reloadToken])

  return { data, loading, error, reload }
}

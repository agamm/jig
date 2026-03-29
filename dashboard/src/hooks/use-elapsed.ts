import { useState, useEffect } from "react"

/** Counts seconds while `active` is true. Resets to 0 when `active` becomes false. */
export function useElapsed(active: boolean) {
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!active) { setElapsed(0); return }
    const start = Date.now()
    const t = setInterval(() => setElapsed(Math.round((Date.now() - start) / 1000)), 1000)
    return () => clearInterval(t)
  }, [active])
  return elapsed
}

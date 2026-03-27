/** Format seconds as human-readable duration: "5s", "1m 12s", "2h 3m" */
export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  if (mins < 60) return secs > 0 ? `${mins}m ${secs}s` : `${mins}m`
  const hours = Math.floor(mins / 60)
  const remainMins = mins % 60
  return remainMins > 0 ? `${hours}h ${remainMins}m` : `${hours}h`
}

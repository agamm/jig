/**
 * Runtime mode detection. Service mode = jig is running on a remote PaaS
 * (Railway, Fly, etc.) with a public HTTPS URL; local mode = developer's laptop.
 *
 * Auto-detected from platform-provided env vars. No `JIG_MODE` or
 * `JIG_SERVICE_MODE` toggle — the public-URL presence IS the signal.
 */

/** True when jig is running as a remote service (Railway/Fly/etc. or explicit JIG_PUBLIC_URL). */
export function isServiceMode(): boolean {
  return !!publicUrl()
}

/**
 * The public HTTPS URL the dashboard + OAuth callbacks are reachable at.
 * Returns undefined in local mode.
 */
export function publicUrl(): string | undefined {
  const explicit = process.env.JIG_PUBLIC_URL
  if (explicit) return stripTrailingSlash(explicit)
  const railway = process.env.RAILWAY_PUBLIC_DOMAIN
  if (railway) return `https://${railway}`
  const render = process.env.RENDER_EXTERNAL_URL
  if (render) return stripTrailingSlash(render)
  const fly = process.env.FLY_APP_NAME
  if (fly) return `https://${fly}.fly.dev`
  return undefined
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url
}

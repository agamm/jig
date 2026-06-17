/**
 * Runtime mode detection. Service mode = jig is running on a remote PaaS
 * (Railway, Fly, etc.) with a public HTTPS URL; local mode = developer's laptop.
 *
 * Auto-detected from platform-provided env vars. No `JIG_MODE` or
 * `JIG_SERVICE_MODE` toggle — the public-URL presence IS the signal.
 */

/**
 * True when jig is running as a remote service. Detected from platform-set
 * env vars that exist independently of whether a public domain has been
 * generated yet — so the lock-flow + service-mode start.ts branches are
 * active from first boot, not only once networking is live.
 */
export function isServiceMode(): boolean {
  if (process.env.JIG_PUBLIC_URL) return true
  if (process.env.RAILWAY_ENVIRONMENT_ID || process.env.RAILWAY_PROJECT_ID) return true
  if (process.env.RENDER) return true
  if (process.env.FLY_APP_NAME) return true
  return false
}

/**
 * The public HTTPS URL the dashboard + OAuth callbacks are reachable at.
 * Returns undefined when service mode is active but no domain has been
 * provisioned yet (common during the initial deploy).
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

/**
 * Best-effort public origin derived from the incoming request — the URL the
 * dashboard was actually loaded from. Used as a fallback when no platform env
 * var resolved a public URL (e.g. a self-hosted reverse proxy on a custom
 * domain). Returns undefined for hosts no external service could reach back to
 * (localhost / private ranges), since those can't receive an inbound webhook.
 */
export function publicUrlFromRequest(req: Request): string | undefined {
  const fwdHost = req.headers.get("x-forwarded-host")
  const host = fwdHost ?? new URL(req.url).host
  if (!host) return undefined

  const hostname = host.split(":")[0].toLowerCase()
  const unreachable =
    hostname === "localhost" ||
    hostname.endsWith(".local") ||
    hostname === "127.0.0.1" ||
    hostname === "::1" ||
    /^10\./.test(hostname) ||
    /^192\.168\./.test(hostname) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
  if (unreachable) return undefined

  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0].trim() || "https"
  return stripTrailingSlash(`${proto}://${host}`)
}

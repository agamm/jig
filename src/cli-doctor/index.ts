/**
 * `jig doctor` — run a short list of health checks against a deployed
 * jig instance. Modelled on `openclaw doctor`: quick pass/warn/fail output
 * the user can scan in two seconds.
 *
 * v1 checks:
 *   - reachable: /api/health returns 200
 *   - unlocked: password has been set AND the server holds the key
 *   - password_set: a password has been configured at least once
 *   - disk: volume has free space (best-effort; requires remote enhancement)
 *
 * More checks (OAuth token expiries, backup freshness, cert validity)
 * land in Phase 2.
 */
import { listRemotes, resolveActiveRemote, type RemoteManifest } from "../cli-remote/manifest.js"

type Status = "pass" | "warn" | "fail"

interface Check {
  name: string
  status: Status
  detail?: string
}

interface HealthResponse {
  version: string
  mode: "service" | "local"
  locked: boolean
  password_set: boolean
  uptime_s: number
  public_url: string | null
}

async function fetchHealth(publicUrl: string): Promise<HealthResponse | { error: string }> {
  try {
    const res = await fetch(`${publicUrl}/api/health`, { cache: "no-store" })
    if (!res.ok) return { error: `HTTP ${res.status}` }
    return (await res.json()) as HealthResponse
  } catch (e: any) {
    return { error: e?.message ?? "network error" }
  }
}

async function checkRemote(remote: RemoteManifest): Promise<Check[]> {
  const checks: Check[] = []
  const health = await fetchHealth(remote.public_url)
  if ("error" in health) {
    checks.push({ name: "reachable", status: "fail", detail: health.error })
    return checks
  }
  checks.push({ name: "reachable", status: "pass", detail: `v${health.version} · ${health.mode} · uptime ${formatUptime(health.uptime_s)}` })
  checks.push({
    name: "password_set",
    status: health.password_set ? "pass" : "warn",
    detail: health.password_set ? undefined : "Set a password in the dashboard to enable credential encryption.",
  })
  checks.push({
    name: "unlocked",
    status: health.locked ? "warn" : "pass",
    detail: health.locked ? "Visit the dashboard to enter your password — scheduler is paused." : undefined,
  })
  return checks
}

function formatUptime(secs: number): string {
  if (secs < 60) return `${secs}s`
  if (secs < 3600) return `${Math.floor(secs / 60)}m`
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`
  return `${Math.floor(secs / 86400)}d`
}

function iconFor(status: Status): string {
  if (status === "pass") return "\u2713" // ✓
  if (status === "warn") return "!"
  return "\u2717" // ✗
}

function summarize(checks: Check[]): Status {
  if (checks.some((c) => c.status === "fail")) return "fail"
  if (checks.some((c) => c.status === "warn")) return "warn"
  return "pass"
}

export interface DoctorOptions {
  handle?: string
  json?: boolean
}

export async function runDoctor(opts: DoctorOptions = {}): Promise<void> {
  const remotes = listRemotes()
  if (remotes.length === 0) {
    console.log("No remotes configured. `jig deploy` to provision one — or run `jig start` locally.")
    process.exit(0)
  }

  const target = opts.handle ? resolveActiveRemote(opts.handle) : null
  const toCheck = target ? [target] : remotes

  const results: { remote: RemoteManifest; checks: Check[] }[] = []
  for (const remote of toCheck) {
    const checks = await checkRemote(remote)
    results.push({ remote, checks })
  }

  if (opts.json) {
    console.log(JSON.stringify(results, null, 2))
    process.exit(results.some((r) => summarize(r.checks) === "fail") ? 1 : 0)
  }

  for (const { remote, checks } of results) {
    console.log(`\n${remote.handle} (${remote.target}) — ${remote.public_url}`)
    for (const c of checks) {
      const line = `  ${iconFor(c.status)} ${c.name.padEnd(14)} ${c.detail ?? ""}`
      console.log(line)
    }
  }
  const worst = results.map((r) => summarize(r.checks)).reduce<Status>((acc, s) => {
    if (s === "fail" || acc === "fail") return "fail"
    if (s === "warn" || acc === "warn") return "warn"
    return "pass"
  }, "pass")

  if (worst === "fail") process.exit(1)
}

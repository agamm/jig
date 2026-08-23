/**
 * Thin wrapper around the `railway` CLI.
 *
 * Keeps platform knowledge in one place so `jig deploy` and `jig update`
 * speak a consistent subset of commands. Auth comes from the CLI's own
 * ~/.railway/config.json — we don't store API tokens.
 *
 * Resolves the binary path explicitly so `bun install -g @railway/cli`
 * works even when `~/.bun/bin` isn't on the user's PATH yet.
 */
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export interface RailwayStatus {
  projectId: string
  serviceId: string
  environmentId: string
  projectName: string
}

let _railwayBin: string | null | undefined = undefined

async function commandV(name: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["sh", "-c", `command -v ${name}`], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code === 0 && out.trim()) return out.trim()
  } catch {}
  return null
}

/**
 * Locate the `railway` binary. Checks $PATH first, then common install
 * prefixes (Bun global bin, Homebrew, /usr/local). Cached for the process.
 */
async function resolveRailwayBin(): Promise<string | null> {
  if (_railwayBin !== undefined) return _railwayBin
  const fromPath = await commandV("railway")
  if (fromPath) {
    _railwayBin = fromPath
    return _railwayBin
  }
  const candidates = [
    process.env.BUN_INSTALL ? join(process.env.BUN_INSTALL, "bin", "railway") : null,
    join(homedir(), ".bun/bin/railway"),
    "/opt/homebrew/bin/railway",
    "/usr/local/bin/railway",
    join(homedir(), ".local/bin/railway"),
  ].filter((p): p is string => Boolean(p))
  for (const p of candidates) {
    if (existsSync(p)) {
      _railwayBin = p
      return p
    }
  }
  _railwayBin = null
  return null
}

function invalidateRailwayBin(): void {
  _railwayBin = undefined
}

async function railwayBinOrThrow(): Promise<string> {
  const bin = await resolveRailwayBin()
  if (!bin) {
    throw new Error(
      "railway binary not found on PATH or common install locations. " +
        "Try `bun install -g @railway/cli` and ensure `~/.bun/bin` is on PATH.",
    )
  }
  return bin
}

/** Spawn a railway command inheriting stdio (interactive) and return exit code. */
export async function railwayInteractive(args: string[], cwd = process.cwd()): Promise<number> {
  const bin = await railwayBinOrThrow()
  const proc = Bun.spawn([bin, ...args], { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" })
  return await proc.exited
}

/** Spawn a railway command capturing stdout; throws on non-zero exit. */
export async function railwayText(args: string[], cwd = process.cwd()): Promise<string> {
  const bin = await railwayBinOrThrow()
  const proc = Bun.spawn([bin, ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`railway ${args.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`)
  }
  return stdout
}

export async function isRailwayInstalled(): Promise<boolean> {
  return (await resolveRailwayBin()) !== null
}

export async function installRailway(): Promise<void> {
  console.log("Installing @railway/cli globally via bun...")
  const install = Bun.spawn(["bun", "install", "-g", "@railway/cli"], {
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await install.exited
  if (exitCode !== 0) throw new Error("Failed to install @railway/cli. Install it manually and retry.")
  // Force a re-resolve next time; the binary should now exist at ~/.bun/bin.
  invalidateRailwayBin()
  const bin = await resolveRailwayBin()
  if (!bin) {
    throw new Error(
      "Installed @railway/cli but couldn't locate the `railway` binary. " +
        "Expected it at ~/.bun/bin/railway. Add ~/.bun/bin to your PATH and re-run `jig deploy`.",
    )
  }
  console.log(`  Installed at ${bin}`)
}

export async function isLoggedIn(): Promise<boolean> {
  try {
    const out = await railwayText(["whoami"])
    return out.trim().length > 0 && !out.toLowerCase().includes("not logged in")
  } catch {
    return false
  }
}

/**
 * Read the currently-linked project. `railway status --json` returns the
 * full project payload; we pick the first environment + its first service
 * instance to derive the IDs we need.
 */
interface StatusPayload {
  id: string
  name: string
  environments?: {
    edges?: {
      node?: {
        id: string
        name: string
        serviceInstances?: {
          edges?: { node?: { serviceId: string; serviceName: string; environmentId: string } }[]
        }
      }
    }[]
  }
}

export async function getStatus(cwd = process.cwd()): Promise<RailwayStatus | null> {
  try {
    const raw = await railwayText(["status", "--json"], cwd)
    const data = JSON.parse(raw) as StatusPayload
    const envNode = data.environments?.edges?.[0]?.node
    const svcNode = envNode?.serviceInstances?.edges?.[0]?.node
    if (!data.id || !envNode?.id || !svcNode?.serviceId) return null
    return {
      projectId: data.id,
      projectName: data.name,
      serviceId: svcNode.serviceId,
      environmentId: envNode.id,
    }
  } catch {
    return null
  }
}

/** Best-effort public URL detection via `railway domain`. */
export async function getPublicUrl(cwd = process.cwd()): Promise<string | null> {
  try {
    const raw = await railwayText(["domain"], cwd)
    // Output varies by CLI version; grep the first URL-ish line.
    const match = raw.match(/https?:\/\/\S+/)
    return match?.[0] ?? null
  } catch {
    return null
  }
}

export interface RailwayProjectSummary {
  id: string
  name: string
}

/**
 * List all LIVE projects in the logged-in account. Returns [] on failure.
 *
 * Railway's `list --json` includes soft-deleted projects (`deletedAt` set)
 * for ~30 days after deletion. We filter them out so orphan-detection,
 * collision-checks, and rollback logic don't chase phantom records.
 */
export async function listProjects(): Promise<RailwayProjectSummary[]> {
  try {
    const raw = await railwayText(["list", "--json"])
    const data = JSON.parse(raw) as Array<{ id: string; name: string; deletedAt?: string | null }>
    return data
      .filter((p) => !p.deletedAt)
      .map((p) => ({ id: p.id, name: p.name }))
  } catch {
    return []
  }
}

/** Find projects with the given exact name. Used to detect collisions before init. */
export async function findProjectsByName(name: string): Promise<RailwayProjectSummary[]> {
  const all = await listProjects()
  return all.filter((p) => p.name === name)
}

/** Delete a project by ID without confirmation. */
export async function deleteProject(id: string): Promise<boolean> {
  const code = await railwayInteractive(["delete", "-p", id, "-y"])
  return code === 0
}

/** Link the current cwd to a named service inside the current linked project. */
export async function linkService(serviceName: string, cwd = process.cwd()): Promise<boolean> {
  const code = await railwayInteractive(["service", "link", serviceName], cwd)
  return code === 0
}

export interface RailwayVolumeSummary {
  id: string
  name: string
  mountPath: string
}

/**
 * List volumes currently attached to the linked project's active service/env.
 * Returns [] on failure so callers can fail loudly with a clearer message.
 */
export async function listVolumes(cwd = process.cwd()): Promise<RailwayVolumeSummary[]> {
  try {
    const raw = await railwayText(["volume", "list", "--json"], cwd)
    const data = JSON.parse(raw)
    // The CLI's JSON shape isn't stable across versions: tolerate both
    // a flat array and a `{ volumes: [...] }` wrapper. Fields we care about
    // (id, name, mountPath) live on each item regardless.
    const items: unknown[] = Array.isArray(data)
      ? data
      : Array.isArray(data?.volumes)
        ? data.volumes
        : []
    const out: RailwayVolumeSummary[] = []
    for (const item of items) {
      if (!item || typeof item !== "object") continue
      const o = item as Record<string, unknown>
      const id = typeof o.id === "string" ? o.id : ""
      const name = typeof o.name === "string" ? o.name : ""
      const mountPath = typeof o.mountPath === "string" ? o.mountPath
        : typeof o.mount_path === "string" ? o.mount_path
        : ""
      if (id) out.push({ id, name, mountPath })
    }
    return out
  } catch (error) {
    // Deliberately NOT swallowed into an empty list. "I could not ask Railway"
    // and "Railway says there are no volumes" are different answers, and the
    // caller that matters (deploy) attaches a volume on the second one. A
    // mount at /data shadows whatever is already there, so a transient CLI or
    // network blip turned into a false "no volume" is how an instance loses
    // its credentials, jigs, schedules, and run history.
    throw new Error(
      `Could not list Railway volumes: ${(error as Error)?.message ?? String(error)}`,
    )
  }
}

/**
 * True iff a volume is currently mounted at the given path.
 * Throws when the answer cannot be determined; callers must not treat a
 * failure to check as "no volume".
 */
export async function hasVolumeAtPath(mountPath: string, cwd = process.cwd()): Promise<boolean> {
  const volumes = await listVolumes(cwd)
  return volumes.some((v) => v.mountPath === mountPath)
}

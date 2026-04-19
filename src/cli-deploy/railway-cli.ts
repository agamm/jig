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
  publicDomain?: string
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
 * Read the currently-linked project. Best-effort: `railway status --json`
 * works on some CLI versions; others only emit human text (or no IDs at
 * all). Returns null on any failure; callers must tolerate it.
 */
export async function getStatus(cwd = process.cwd()): Promise<RailwayStatus | null> {
  try {
    const raw = await railwayText(["status", "--json"], cwd)
    const data = JSON.parse(raw) as {
      project?: { id: string; name: string }
      service?: { id: string }
      environment?: { id: string }
    }
    if (data.project?.id && data.service?.id && data.environment?.id) {
      return {
        projectId: data.project.id,
        serviceId: data.service.id,
        environmentId: data.environment.id,
        projectName: data.project.name,
      }
    }
  } catch {
    // falls through to text parsing
  }
  return null
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

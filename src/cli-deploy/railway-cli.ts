/**
 * Thin wrapper around the `railway` CLI.
 *
 * Keeps platform knowledge in one place so `jig deploy` and `jig update`
 * speak a consistent subset of commands. Auth comes from the CLI's own
 * ~/.railway/config.json — we don't store API tokens.
 */

export interface RailwayStatus {
  projectId: string
  serviceId: string
  environmentId: string
  projectName: string
  publicDomain?: string
}

/** Spawn a railway command inheriting stdio (interactive) and return exit code. */
export async function railwayInteractive(args: string[], cwd = process.cwd()): Promise<number> {
  const proc = Bun.spawn(["railway", ...args], { cwd, stdout: "inherit", stderr: "inherit", stdin: "inherit" })
  return await proc.exited
}

/** Spawn a railway command capturing stdout; throws on non-zero exit. */
export async function railwayText(args: string[], cwd = process.cwd()): Promise<string> {
  const proc = Bun.spawn(["railway", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
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
  try {
    const proc = Bun.spawn(["railway", "--version"], { stdout: "pipe", stderr: "pipe" })
    await proc.exited
    return proc.exitCode === 0
  } catch {
    return false
  }
}

export async function installRailway(): Promise<void> {
  console.log("Installing @railway/cli globally via bun...")
  const code = await railwayInteractive(["--version"]).catch(() => -1)
  if (code === 0) return
  const install = Bun.spawn(["bun", "install", "-g", "@railway/cli"], {
    stdout: "inherit",
    stderr: "inherit",
  })
  const exitCode = await install.exited
  if (exitCode !== 0) throw new Error("Failed to install @railway/cli. Install it manually and retry.")
}

export async function isLoggedIn(): Promise<boolean> {
  try {
    const out = await railwayText(["whoami"])
    return out.trim().length > 0 && !out.toLowerCase().includes("not logged in")
  } catch {
    return false
  }
}

/** Read the currently-linked project's IDs via `railway status --json`. */
export async function getStatus(cwd = process.cwd()): Promise<RailwayStatus | null> {
  try {
    const raw = await railwayText(["status", "--json"], cwd)
    const data = JSON.parse(raw) as {
      project?: { id: string; name: string }
      service?: { id: string }
      environment?: { id: string }
    }
    if (!data.project || !data.service || !data.environment) return null
    return {
      projectId: data.project.id,
      serviceId: data.service.id,
      environmentId: data.environment.id,
      projectName: data.project.name,
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

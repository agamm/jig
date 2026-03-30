import { join } from "path"
import { homedir } from "os"
import { existsSync } from "fs"
import { PROJECT_ROOT } from "../config/paths.js"

export type StdioServerConfig = {
  type: "stdio"
  command: string
  args: string[]
  description: string
}

export type RemoteServerConfig = {
  type: "remote"
  url: string
  description: string
  auth?: string
}

export type RepoServerConfig = {
  type: "repo"
  repo: string
  entry: string
  build?: string
  description: string
}

export type ServerConfig = StdioServerConfig | RemoteServerConfig | RepoServerConfig

type ServerRegistry = Record<string, ServerConfig>

const SERVERS_DIR = join(homedir(), ".jig", "servers")

function expandHome(str: string): string {
  return str.replace(/^~\//, homedir() + "/")
}

/**
 * Run a token_command and return the token string.
 */
export async function resolveToken(command: string): Promise<string> {
  const proc = Bun.spawn(["sh", "-c", command], { stdout: "pipe", stderr: "pipe" })
  const exitCode = await proc.exited
  if (exitCode !== 0) {
    const stderr = await new Response(proc.stderr).text()
    throw new Error(`Token command failed: ${command}\n${stderr.trim()}`)
  }
  return (await new Response(proc.stdout).text()).trim()
}

/**
 * Ensure a repo server is cloned and built. Returns the resolved entry path.
 */
async function ensureRepo(name: string, config: RepoServerConfig): Promise<string> {
  const repoDir = join(SERVERS_DIR, name)
  const entryPath = join(repoDir, config.entry)

  if (!existsSync(repoDir)) {
    console.log(`[jig] Cloning ${config.repo} → ${repoDir}...`)
    const clone = Bun.spawn(["git", "clone", config.repo, repoDir], {
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await clone.exited
    if (exitCode !== 0) throw new Error(`Failed to clone ${config.repo}`)
  }

  if (!existsSync(entryPath) && config.build) {
    console.log(`[jig] Building ${name}...`)
    const build = Bun.spawn(["sh", "-c", config.build], {
      cwd: repoDir,
      stdout: "inherit",
      stderr: "inherit",
    })
    const exitCode = await build.exited
    if (exitCode !== 0) throw new Error(`Failed to build ${name}`)
  }

  if (!existsSync(entryPath)) {
    throw new Error(
      `Entry point not found: ${entryPath}\n` +
      `Try building manually: cd ${repoDir} && ${config.build ?? "npm install && npm run build"}`
    )
  }

  return entryPath
}

export async function loadServerConfigs(): Promise<ServerRegistry> {
  const file = Bun.file(join(PROJECT_ROOT, "servers/default.json"))
  const raw = await file.json() as ServerRegistry

  for (const config of Object.values(raw)) {
    if (config.type === "stdio") {
      config.args = config.args.map(expandHome)
    }
  }
  return raw
}

/**
 * Get a server config by name. Repo configs are resolved to stdio configs.
 */
export async function getServerConfig(name: string): Promise<StdioServerConfig | RemoteServerConfig> {
  const configs = await loadServerConfigs()
  const config = configs[name]
  if (!config) {
    const available = Object.keys(configs).join(", ")
    throw new Error(`Unknown server "${name}". Available: ${available}`)
  }

  if (config.type === "repo") {
    const entryPath = await ensureRepo(name, config)
    return {
      type: "stdio",
      command: "node",
      args: [entryPath],
      description: config.description,
    }
  }

  return config
}

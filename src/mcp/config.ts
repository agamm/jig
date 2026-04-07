import { join } from "path"
import { homedir } from "os"
import { existsSync } from "fs"
import { PROJECT_ROOT } from "../config/paths.js"
import { getCredential } from "../db.js"

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
  headers?: Record<string, string>
  setup?: string
}

export type RepoServerConfig = {
  type: "repo"
  repo: string
  entry: string
  build?: string
  description: string
}

export type ServerMeta = {
  pricing?: string
  limits?: string
  docs?: string
  provider?: string
}

export type ProxyConfig = {
  via: string
  discover: string
  /** URL to the provider's dashboard where users can add more connections */
  dashboardUrl?: string
}

export type ServerConfig = (StdioServerConfig | RemoteServerConfig | RepoServerConfig) & {
  meta?: ServerMeta
  proxy?: ProxyConfig
}

type ServerRegistry = Record<string, ServerConfig>

const SERVERS_DIR = join(homedir(), ".jig", "servers")

function expandHome(str: string): string {
  return str.replace(/^~\//, homedir() + "/")
}

/**
 * Replace $VAR references in a string with values from the SQLite credentials table.
 * Returns { resolved, missing } — missing lists any credential keys not found in the DB.
 */
export function resolveCredentials(str: string): { resolved: string; missing: string[] } {
  const missing: string[] = []
  const resolved = str.replace(/\$([A-Z_][A-Z0-9_]*)/g, (_, name) => {
    const value = getCredential(name)
    if (value != null) return value
    missing.push(name)
    return `$${name}`
  })
  return { resolved, missing }
}

/**
 * Check a remote config for unresolved $VAR credential references.
 * Returns list of missing credential keys, or empty array if all resolved.
 */
export function checkMissingCredentials(config: ServerConfig): string[] {
  const missing: string[] = []
  if (config.type === "remote") {
    missing.push(...resolveCredentials(config.url).missing)
    if (config.headers) {
      for (const v of Object.values(config.headers)) {
        missing.push(...resolveCredentials(v).missing)
      }
    }
  }
  return [...new Set(missing)]
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

  // Resolve $VAR references in remote config from the SQLite credentials table
  if (config.type === "remote") {
    config.url = resolveCredentials(config.url).resolved
    if (config.headers) {
      for (const [k, v] of Object.entries(config.headers)) {
        config.headers[k] = resolveCredentials(v).resolved
      }
    }
  }

  return config
}

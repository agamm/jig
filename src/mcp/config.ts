import { join } from "path"
import { homedir } from "os"
import { existsSync } from "fs"
import { mkdir } from "fs/promises"
import { CUSTOM_SERVERS_PATH, PROJECT_ROOT } from "../config/paths.js"
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
  /**
   * Read-only tool the onboarding wizard calls to prove this connection
   * returns real data, not just that a schema file exists. Optional: without
   * it, verification falls back to an authenticated tools/list handshake.
   */
  verify?: { tool: string; args?: Record<string, unknown> }
  pricing?: string
  limits?: string
  docs?: string
  provider?: string
  authoringHints?: string[]
}

export type ProxyConfig = {
  via: string
  connectDiscovery: string
  /** URL to the provider's dashboard where users can add more connections */
  dashboardUrl?: string
}

export type ServerConfig = (StdioServerConfig | RemoteServerConfig | RepoServerConfig) & {
  meta?: ServerMeta
  proxy?: ProxyConfig
  /** Authoring-time discovery hook used by jig generation to resolve dynamic runtime targets. */
  authoringDiscovery?: string
  /** When true, the server is kept in the registry for reference but not offered/loadable. */
  disabled?: boolean
  /** Free-text note (e.g. why it's disabled). Ignored at runtime. */
  _note?: string
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
  const custom = await loadCustomServerConfigs()
  const merged = { ...raw, ...custom }

  for (const [name, config] of Object.entries(merged)) {
    // Disabled servers stay in default.json for reference (see their `_note`)
    // but are never offered, connected, or loadable.
    if (config.disabled) {
      delete merged[name]
      continue
    }
    if (config.type === "stdio") {
      config.args = config.args.map(expandHome)
    }
  }
  return merged
}

export async function loadCustomServerConfigs(): Promise<ServerRegistry> {
  if (!existsSync(CUSTOM_SERVERS_PATH)) return {}

  const file = Bun.file(CUSTOM_SERVERS_PATH)
  const raw = await file.json().catch(() => ({})) as ServerRegistry
  if (!raw || typeof raw !== "object") return {}
  return sanitizeCustomConfigs(raw)
}

/**
 * The custom-servers file is user-writable. The only supported writer,
 * createCustomRemoteServer, emits plain `type:"remote"` entries — but a
 * hand-edited or tampered file could carry a config that reaches a shell:
 * `type:"stdio"` (spawns command+args), `type:"repo"` (git clone + `sh -c`
 * build), or an `auth`/`build`/`command` field on any type. Those are RCE
 * vectors, and a same-named entry would shadow a trusted default via the merge
 * in loadServerConfigs. Enforce the invariant on load: keep only remote
 * connections, rebuilt from an allowlist of non-executable fields.
 */
const DISALLOWED_CUSTOM_FIELDS = ["auth", "command", "args", "build", "repo", "setup", "authoringDiscovery"]

function sanitizeCustomConfigs(raw: ServerRegistry): ServerRegistry {
  const safe: ServerRegistry = {}
  for (const [name, config] of Object.entries(raw)) {
    if (!config || typeof config !== "object") continue
    if (config.type !== "remote" || typeof (config as RemoteServerConfig).url !== "string") {
      console.warn(`[mcp] Ignoring custom server "${name}": only plain remote connections are allowed in custom configs`)
      continue
    }
    const dropped = DISALLOWED_CUSTOM_FIELDS.filter((k) => k in config)
    if (dropped.length) {
      console.warn(`[mcp] Custom server "${name}": dropped disallowed field(s) ${dropped.join(", ")} (not permitted in custom configs)`)
    }
    const c = config as RemoteServerConfig
    const clean: RemoteServerConfig = {
      type: "remote",
      url: c.url,
      description: c.description || "Custom MCP server",
    }
    if (c.headers && typeof c.headers === "object") clean.headers = c.headers
    safe[name] = clean
  }
  return safe
}

export async function createCustomRemoteServer(input: {
  name: string
  url: string
  description?: string
}): Promise<{ name: string; config: RemoteServerConfig }> {
  const name = input.name.trim()
  const url = input.url.trim()
  const description = input.description?.trim() || "Custom MCP server"

  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error("Connection name must use lowercase letters, numbers, underscores, or hyphens")
  }
  if (name === "custom") {
    throw new Error("Connection name \"custom\" is reserved")
  }
  // SSRF guard: an internet-reachable dashboard would otherwise let a custom
  // connection point at http://169.254.169.254/... (cloud metadata) or an
  // internal host and have the server fetch it on connect. assertPublicUrl
  // enforces http(s) and rejects loopback/private/link-local/metadata targets.
  let parsedUrl: URL
  try {
    const { assertPublicUrl } = await import("../net/ssrf.js")
    parsedUrl = await assertPublicUrl(url)
  } catch (e) {
    const msg = (e as Error)?.message ?? "invalid URL"
    throw new Error(`Custom MCP URL rejected: ${msg}`)
  }

  const defaultConfigs = await Bun.file(join(PROJECT_ROOT, "servers/default.json")).json() as ServerRegistry
  const customConfigs = await loadCustomServerConfigs()
  if (defaultConfigs[name] || customConfigs[name]) {
    throw new Error(`Connection already exists: ${name}`)
  }

  const config: RemoteServerConfig = {
    type: "remote",
    url: parsedUrl.toString(),
    description,
  }

  const nextConfigs = Object.fromEntries(
    Object.entries({ ...customConfigs, [name]: config }).sort(([a], [b]) => a.localeCompare(b))
  )

  await mkdir(join(PROJECT_ROOT, ".jig"), { recursive: true, mode: 0o700 })
  await Bun.write(CUSTOM_SERVERS_PATH, JSON.stringify(nextConfigs, null, 2) + "\n")

  return { name, config }
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

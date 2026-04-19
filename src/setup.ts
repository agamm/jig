/**
 * One-time setup for jig environment.
 *
 * Run: bun run src/setup.ts
 *
 * Idempotent — safe to run multiple times.
 */
import { join } from "path"
import { existsSync, readFileSync, appendFileSync } from "fs"

const PROJECT_ROOT = join(import.meta.dir, "..")
const JIGS_DIR = join(PROJECT_ROOT, "jigs")

async function run(cmd: string[], cwd?: string): Promise<{ ok: boolean; output: string }> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  return { ok: code === 0, output: (stdout + stderr).trim() }
}

function log(icon: string, msg: string) {
  console.log(`  ${icon} ${msg}`)
}

async function setupAgentBrowser() {
  console.log("\nAgent Browser")
  const { ok } = await run(["npx", "agent-browser", "--version"])
  if (!ok) {
    log("!", "agent-browser not found — install with: npm i -g agent-browser")
    return
  }
  log("\u2713", "agent-browser available")

  const { ok: installed } = await run(["npx", "agent-browser", "install", "chromium"])
  if (installed) {
    log("\u2713", "chromium engine ready")
  } else {
    log("!", "chromium install failed — run manually: npx agent-browser install chromium")
  }
}

async function setupJigsGit() {
  console.log("\nJigs Version Control")
  const gitDir = join(JIGS_DIR, ".git")

  if (existsSync(gitDir)) {
    log("\u2713", "jigs/.git already initialized")
  } else {
    const { ok } = await run(["git", "init"], JIGS_DIR)
    if (ok) {
      // Initial commit so version history starts clean
      await run(["git", "add", "-A"], JIGS_DIR)
      await run(["git", "commit", "-m", "Initial jig snapshot", "--allow-empty"], JIGS_DIR)
      log("\u2713", "initialized jigs/.git")
    } else {
      log("!", "failed to init jigs/.git")
    }
  }

  // Ensure parent .gitignore has jigs/.git
  const parentIgnore = join(PROJECT_ROOT, ".gitignore")
  if (existsSync(parentIgnore)) {
    const content = readFileSync(parentIgnore, "utf-8")
    if (!content.includes("jigs/.git")) {
      appendFileSync(parentIgnore, "\njigs/.git\n")
      log("\u2713", "added jigs/.git to parent .gitignore")
    } else {
      log("\u2713", ".gitignore already excludes jigs/.git")
    }
  }
}

function checkEnv() {
  console.log("\nEnvironment")
  // getOpenRouterApiKey prefers the credentials table, falls back to env.
  // Importing async to avoid pulling db dependencies into setup's top level.
  const { getOpenRouterApiKey } = require("./config/openrouter.js") as typeof import("./config/openrouter.js")
  const key = getOpenRouterApiKey()
  if (key) {
    const source = process.env.OPENROUTER_API_KEY === key ? ".env" : "credentials"
    log("\u2713", `OpenRouter API key set (${source})`)
  } else {
    log("!", "OpenRouter API key not set — add one in the dashboard or set OPENROUTER_API_KEY in .env")
  }
}

function checkConnections() {
  console.log("\nConnections")
  const configPath = join(PROJECT_ROOT, ".jig/config.json")
  if (!existsSync(configPath)) {
    log("!", ".jig/config.json not found — run jig connect to set up servers")
    return
  }
  const config = JSON.parse(readFileSync(configPath, "utf-8"))
  const servers = Object.keys(config.mcpServers ?? config)
  const schemasDir = join(PROJECT_ROOT, ".jig/schemas")
  for (const name of servers) {
    const hasSchema = existsSync(join(schemasDir, `${name}.json`))
    log(hasSchema ? "\u2713" : "!", `${name} ${hasSchema ? "connected" : "not connected — run jig connect " + name}`)
  }
}

console.log("jig setup\n=========")
await setupAgentBrowser()
await setupJigsGit()
checkEnv()
checkConnections()
console.log()

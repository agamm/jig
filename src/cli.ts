#!/usr/bin/env bun
/**
 * Jig CLI — thin glue that wires terminal I/O to reusable modules.
 *
 * Business logic emits structured JigEvents. This file renders them as text.
 * A dashboard would render the same events as UI components.
 */
import { loadServerConfigs } from "./mcp/config.js"
import { discoverJigs } from "./discover.js"
import { existsSync } from "fs"
import { join, relative } from "path"
import { createInterface } from "node:readline/promises"
import type { JigIO, JigEvent } from "./creator.js"
import { CreatorError } from "./creator.js"

const API_PORT = parseInt(process.env.PORT ?? "3141")
const API_BASE = `http://localhost:${API_PORT}`

const PROJECT_ROOT = join(import.meta.dir, "..")
const SCHEMAS_DIR = join(PROJECT_ROOT, ".jig/schemas")

const rawArgs = process.argv.slice(2)
const dryRun = rawArgs.includes("--dry-run")
const args = rawArgs.filter((a) => a !== "--dry-run")
const [command, ...rest] = args

if (dryRun) {
  const { setDryRun } = await import("./sdk/dryrun.js")
  setDryRun(true)
}

// ---------------------------------------------------------------------------
// CLI renderer — turns structured events into terminal output
// ---------------------------------------------------------------------------

// Loading timer — shows elapsed seconds on the current line via \r overwrite
let loadingTimer: Timer | null = null
let loadingStart = 0
let loadingLabel = ""

function startLoading(label: string) {
  stopLoading()
  loadingStart = Date.now()
  loadingLabel = label
  if (process.stderr.isTTY) {
    const tick = () => {
      const secs = ((Date.now() - loadingStart) / 1000).toFixed(0)
      process.stderr.write(`\r\x1b[2K${label} ${secs}s`)
    }
    tick()
    loadingTimer = setInterval(tick, 1000)
  } else {
    console.log(label)
  }
}

function stopLoading() {
  if (loadingTimer) {
    clearInterval(loadingTimer)
    loadingTimer = null
    process.stderr.write(`\r\x1b[2K`)
  }
}

function finishLoading(result: string) {
  const secs = ((Date.now() - loadingStart) / 1000).toFixed(1)
  stopLoading()
  console.log(`${result} (${secs}s)`)
}

function renderEvent(event: JigEvent): void {
  switch (event.type) {
    // Creator events
    case "connections":
      stopLoading()
      console.log("\nChecking connections...")
      for (const s of event.servers) {
        console.log(`  ${s.name} ${s.connected ? "\u2713" : "\u2717"}  ${s.description}`)
      }
      break
    case "connections-missing":
      stopLoading()
      console.error("\nThis jig needs services that aren't connected yet. Run:\n")
      for (const s of event.servers) console.error(`  ${s.command}`)
      break
    case "connections-unknown":
      stopLoading()
      for (const s of event.servers) {
        console.error(`\n"${s.name}" isn't a predefined service. To add it:\n`)
        console.error(`1. Add to servers/default.json:`)
        console.error(`   "${s.name}": { "type": "remote", "url": "<MCP server URL>", "description": "..." }\n`)
        console.error(`2. Then run: jig connect ${s.name}`)
      }
      break
    case "plan":
      finishLoading("Planning...")
      console.log(`\nPlan: ${event.name}`)
      console.log(`  Servers: ${event.servers.join(", ")}`)
      console.log(`  Tool scope: ${event.relevantTools.join(", ")}`)
      break
    case "probe-start":
      // No loading timer — agent() has its own spinner
      loadingStart = Date.now()
      console.log(`\nProbing ${event.tools.length} tools...`)
      for (const t of event.tools) console.log(`  ${t}`)
      break
    case "probe-done": {
      const secs = ((Date.now() - loadingStart) / 1000).toFixed(1)
      const lines = event.summary.split("\n")
      const preview = lines.length > 12 ? [...lines.slice(0, 10), `  ... (${lines.length - 10} more lines)`] : lines
      console.log(`\nProbe results (${secs}s):`)
      for (const l of preview) console.log(`  ${l}`)
      break
    }
    case "generate-start":
      console.log(""); startLoading("Generating jig...")
      break
    case "write":
      finishLoading("Generating jig...")
      console.log(`Writing ${event.file}...`)
      break
    case "validate":
      stopLoading()
      console.log(event.ok ? "Validating... ok" : `Validating... errors found\n${event.errors}`)
      break
    case "fix":
      startLoading(`Fixing... attempt ${event.attempt}/${event.max}`)
      break
    case "dry-run-start":
      // No loading timer — the jig's agent() has its own spinner
      loadingStart = Date.now()
      console.log("\nDry-running...")
      break
    case "dry-run-review": {
      const secs = ((Date.now() - loadingStart) / 1000).toFixed(1)
      console.log(event.ok ? `Dry-run review... ok (${secs}s)` : `Dry-run review found issues (${secs}s):\n${event.issues}`)
      break
    }
    case "created":
      stopLoading()
      console.log(`\nCreated: ${event.file}`)
      console.log(`Run with: jig run ${event.name}`)
      break
    case "updated":
      stopLoading()
      console.log(`\nUpdated: ${event.file}`)
      break
    case "error":
      stopLoading()
      console.error(event.message)
      if (event.details?.suggestion) console.error(`Try: ${event.details.suggestion}`)
      if (event.details?.commands) {
        for (const cmd of event.details.commands) console.error(`  ${cmd}`)
      }
      break

    // Connect events
    case "server-list":
      console.log("Servers:\n")
      for (const s of event.servers) {
        if (s.connected) {
          console.log(`  ${s.name.padEnd(14)} \u2713 ${String(s.toolCount).padStart(2)} tools   ${s.description}`)
        } else {
          console.log(`  ${s.name.padEnd(14)} \u25CB            ${s.description}`)
        }
      }
      console.log(`\nRun "jig connect <name>" to connect a server.`)
      break
    case "connecting":
      console.log(`Connecting to ${event.server}...`)
      break
    case "tools-discovered":
      console.log(`${event.count} tools discovered:`)
      for (const t of event.tools) console.log(`  ${t}`)
      break
    case "server-ready":
      console.log(`\n${event.server} is ready.`)
      break

    // Run events
    case "jig-list":
      console.log("Available jigs:\n")
      for (const j of event.jigs) {
        console.log(j.entities.length ? `  ${j.name}  [${j.entities.join(", ")}]` : `  ${j.name}`)
      }
      console.log(`\nRun "jig run <name>" or "jig run <name> <entity>"`)
      break
    case "entity-list":
      console.log(`${event.name} entities: ${event.entities.join(", ")}`)
      console.log(`\nRun "jig run ${event.name} <entity>" or "jig run ${event.name} all"`)
      break
    case "run-start":
      console.log(`\n--- ${event.name} ---`)
      break

    default: {
      const _exhaustive: never = event
      break
    }
  }
}

function makeIO(): JigIO {
  return {
    ask: async (question: string) => {
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const answer = await rl.question(`${question}\n> `)
      rl.close()
      if (!answer.trim()) throw new Error("Input cannot be empty")
      return answer.trim()
    },
    emit: renderEvent,
  }
}

const io = makeIO()

// ---------------------------------------------------------------------------
// Server-backed agent — ensures server is running, then calls /api/agent
// ---------------------------------------------------------------------------

async function ensureServer(): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/jigs`)
    if (res.ok) return // Server already running
  } catch {}

  // Start server in background
  console.log("Starting server...")
  const proc = Bun.spawn(["bun", "run", "src/server.ts"], {
    cwd: PROJECT_ROOT,
    stdout: "ignore",
    stderr: "ignore",
    env: { ...process.env, PORT: String(API_PORT) },
  })
  proc.unref() // Don't block CLI exit

  // Wait for server to be ready (up to 5s)
  for (let i = 0; i < 50; i++) {
    await new Promise(r => setTimeout(r, 100))
    try {
      const res = await fetch(`${API_BASE}/api/jigs`)
      if (res.ok) return
    } catch {}
  }
  throw new Error("Failed to start server")
}

async function agentCommand(instruction: string, jigId?: string, entity?: string): Promise<void> {
  await ensureServer()

  // Start agent session
  const startRes = await fetch(`${API_BASE}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, jigId, entity }),
  })
  if (!startRes.ok) {
    const err = await startRes.json().catch(() => ({ error: "Failed" }))
    console.error(err.error ?? "Failed to start agent")
    process.exit(1)
  }

  const { sessionId } = await startRes.json()
  let eventIndex = 0

  // Poll for events
  for (let i = 0; i < 300; i++) {
    await new Promise(r => setTimeout(r, 1000))

    const res = await fetch(`${API_BASE}/api/agent/${sessionId}?since=${eventIndex}`)
    if (!res.ok) continue
    const data = await res.json()

    // Render new events
    for (const event of data.events ?? []) {
      if (event.type === "tool-call") {
        const statusIcon = event.status === "done" ? "\u2713" : event.status === "error" ? "\u2717" : "\u2026"
        const argsStr = Object.entries(event.args as Record<string, any>)
          .filter(([k]) => k !== "code")
          .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 50) : JSON.stringify(v)}`)
          .join(", ")
        console.log(`  ${statusIcon} ${event.tool}${argsStr ? ` (${argsStr})` : ""}`)
        if (event.tool === "check_jig" && event.result && event.result !== "ok") {
          console.log(`    ${event.result.replace(/\n/g, "\n    ")}`)
        }
      } else if (event.type === "text") {
        console.log(`\n${event.content}`)
      }
    }

    eventIndex += (data.events?.length ?? 0)

    if (data.status === "done") {
      if (data.jigId) console.log(`\nJig: ${data.jigId}`)
      return
    }
    if (data.status === "error") {
      process.exit(1)
    }
  }

  console.error("Agent timed out")
  process.exit(1)
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

try {
  switch (command) {
    case "connect":
      await connect(rest[0], io)
      break

    case "run":
      await handleRun(rest[0], rest[1], io)
      break

    case "new": {
      const desc = rest.join(" ") || await io.ask("What should this jig do?")
      console.log("")
      await agentCommand(desc)
      process.exit(0)
      break
    }

    case "edit": {
      const [name, entity] = rest
      if (!name) { io.emit({ type: "error", code: "usage", message: "Usage: jig edit <name> [entity]" }); process.exit(1) }
      const instruction = await io.ask("What should change?")
      console.log("")
      await agentCommand(instruction, name, entity ?? undefined)
      process.exit(0)
      break
    }

    case "start": {
      const { startServer } = await import("./start.js")
      await startServer()
      break
    }

    default:
      console.log(`jig — AI workflow automation\n`)
      console.log(`Commands:`)
      console.log(`  jig start              Start dashboard + API server`)
      console.log(`  jig connect [server]   List servers or connect one`)
      console.log(`  jig run <name> [args]  Run a jig`)
      console.log(`  jig new [description]  AI generates a new jig`)
      console.log(`  jig edit <name> [ent]  AI modifies an existing jig`)
      break
  }
} catch (e: any) {
  if (e instanceof CreatorError) {
    process.exit(1) // events already emitted
  }
  if (e?.message) console.error(e.message)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// connect — uses structured events
// ---------------------------------------------------------------------------

async function connect(serverName: string | undefined, io: JigIO) {
  const configs = await loadServerConfigs()

  if (!serverName) {
    const servers = await Promise.all(
      Object.entries(configs).map(async ([name, config]) => {
        const schemaPath = join(SCHEMAS_DIR, `${name}.json`)
        const connected = existsSync(schemaPath)
        const toolCount = connected ? (await Bun.file(schemaPath).json()).length : 0
        return { name, connected, toolCount, description: config.description }
      })
    )
    io.emit({ type: "server-list", servers })
    return
  }

  const { getServerConfig } = await import("./mcp/config.js")
  const { connectServer, discoverTools, ensureAnnotations } = await import("./mcp/client.js")

  io.emit({ type: "connecting", server: serverName })
  const config = await getServerConfig(serverName)
  const connection = await connectServer(serverName, config)
  const tools = await discoverTools(connection)

  // LLM classifies read/write annotations — only during jig connect, not runtime
  await ensureAnnotations(tools)
  // Re-save schemas with enriched annotations
  await Bun.write(join(SCHEMAS_DIR, `${serverName}.json`), JSON.stringify(tools, null, 2))

  io.emit({ type: "tools-discovered", server: serverName, count: tools.length, tools: tools.map(t => t.name) })

  // Regenerate types + connection modules
  const typegen = Bun.spawn(["bun", "run", "src/mcp/typegen.ts"], {
    cwd: PROJECT_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  })
  await typegen.exited

  io.emit({ type: "server-ready", server: serverName })
  process.exit(0)
}

// ---------------------------------------------------------------------------
// run — uses structured events
// ---------------------------------------------------------------------------

function checkConnections(io: JigIO) {
  const connectionsDir = join(PROJECT_ROOT, ".jig/connections")
  if (!existsSync(connectionsDir) || !existsSync(join(connectionsDir, "index.ts"))) {
    io.emit({ type: "error", code: "no-connections", message: `No connections found. Run "jig connect <server>" first.` })
    process.exit(1)
  }
}

async function runJigFile(path: string, io: JigIO, jigId: string, entity?: string) {
  const { runJig, persist } = await import("./runner.js")
  const { openDb, insertRun } = await import("./db.js")

  openDb()

  // Extract param definitions — lightweight import just for prompting
  let paramDefs: Record<string, string> = {}
  try {
    const mod = await import(path)
    paramDefs = mod.default?.options?.params ?? {}
  } catch {
    // Import errors will be caught and classified by runJig() below
  }

  const params: Record<string, string> = {}
  for (const [name, desc] of Object.entries(paramDefs)) {
    params[name] = await io.ask(`${name} (${desc})`)
  }

  const isDry = dryRun
  const runId = isDry ? -1 : insertRun(jigId, entity, Object.keys(params).length > 0 ? params : undefined)
  const start = Date.now()
  const persistHandler = !isDry ? persist(runId, start) : null

  const result = await runJig(path, params, (event) => {
    if (event.type === "error") console.error(event.message)
    persistHandler?.(event)
  })

  if (result.error) process.exit(1)
}

async function handleRun(name: string | undefined, entity: string | undefined, io: JigIO) {
  const jigsDir = join(PROJECT_ROOT, "jigs")
  const jigs = discoverJigs(jigsDir)

  if (!name) {
    io.emit({
      type: "jig-list",
      jigs: [...jigs.entries()].map(([name, entities]) => ({ name, entities })),
    })
    return
  }

  if (!jigs.has(name)) {
    io.emit({ type: "error", code: "jig-not-found", message: `Jig not found: ${name}` })
    process.exit(1)
  }
  checkConnections(io)
  const entities = jigs.get(name)!

  if (entities.length === 0) {
    await runJigFile(join(jigsDir, `${name}.ts`), io, name)
    return
  }

  if (!entity) {
    io.emit({ type: "entity-list", name, entities })
    return
  }

  if (entity === "all") {
    for (const e of entities) {
      io.emit({ type: "run-start", name: `${name}/${e}` })
      await runJigFile(join(jigsDir, name, `${e}.ts`), io, name, e)
    }
    return
  }

  if (!entities.includes(entity)) {
    io.emit({ type: "error", code: "entity-not-found", message: `Entity not found: ${name}/${entity}` })
    process.exit(1)
  }
  await runJigFile(join(jigsDir, name, `${entity}.ts`), io, name, entity)
}

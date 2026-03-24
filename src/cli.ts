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
// Command dispatch
// ---------------------------------------------------------------------------

try {
  switch (command) {
    case "connect":
      await connect(rest[0], io)
      break

    case "run":
      await runJig(rest[0], rest[1], io)
      break

    case "new": {
      const { createJig } = await import("./creator.js")
      const desc = rest.join(" ") || await io.ask("What should this jig do?")
      console.log(""); startLoading("Planning...")
      await createJig(desc, io)
      process.exit(0)
      break
    }

    case "edit": {
      const { editJig } = await import("./creator.js")
      const [name, entity] = rest
      if (!name) { io.emit({ type: "error", code: "usage", message: "Usage: jig edit <name> [entity]" }); process.exit(1) }
      const instruction = await io.ask("What should change?")
      console.log(""); startLoading("Planning...")
      await editJig(name, entity ?? undefined, instruction, io)
      process.exit(0)
      break
    }

    default:
      console.log(`jig — AI workflow automation\n`)
      console.log(`Commands:`)
      console.log(`  jig connect [server]   List servers or connect one`)
      console.log(`  jig run <name> [args]  Run a jig`)
      console.log(`  jig new [description]  AI generates a new jig`)
      console.log(`  jig edit <name> [ent]  AI modifies an existing jig`)
      break
  }
} catch (e) {
  if (e instanceof CreatorError) {
    process.exit(1) // events already emitted
  }
  throw e
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

async function execJig(path: string, io: JigIO) {
  const { run } = await import("./sdk/jig.js")
  const mod = await import(path)
  const def = mod.default

  // Prompt for missing params through IO (CLI prompts, dashboard shows a form)
  const paramDefs = def.options?.params ?? {}
  const params: Record<string, string> = {}
  for (const [name, desc] of Object.entries(paramDefs)) {
    params[name] = await io.ask(`${name} (${desc})`)
  }

  await run(def, params)
}

async function runJig(name: string | undefined, entity: string | undefined, io: JigIO) {
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
    await execJig(join(jigsDir, `${name}.ts`), io)
    return
  }

  if (!entity) {
    io.emit({ type: "entity-list", name, entities })
    return
  }

  if (entity === "all") {
    for (const e of entities) {
      io.emit({ type: "run-start", name: `${name}/${e}` })
      await execJig(join(jigsDir, name, `${e}.ts`), io)
    }
    return
  }

  if (!entities.includes(entity)) {
    io.emit({ type: "error", code: "entity-not-found", message: `Entity not found: ${name}/${entity}` })
    process.exit(1)
  }
  await execJig(join(jigsDir, name, `${entity}.ts`), io)
}

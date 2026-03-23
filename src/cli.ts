#!/usr/bin/env bun
/**
 * Jig CLI — the entry point for all jig commands.
 *
 * Usage:
 *   jig connect              — list servers and their status
 *   jig connect <server>     — authenticate and set up a server
 *   jig run <name> [args]    — run a jig
 */
import { loadServerConfigs } from "./mcp/config.js"
import { discoverJigs } from "./discover.js"
import { existsSync } from "fs"
import { join } from "path"

const PROJECT_ROOT = join(import.meta.dir, "..")
const SCHEMAS_DIR = join(PROJECT_ROOT, ".jig/schemas")

const [command, ...args] = process.argv.slice(2)

switch (command) {
  case "connect":
    await connect(args[0])
    break

  case "run":
    await runJig(args[0], args[1])
    break

  default:
    console.log(`jig — AI workflow automation\n`)
    console.log(`Commands:`)
    console.log(`  jig connect [server]   List servers or connect one`)
    console.log(`  jig run <name> [args]  Run a jig`)
    break
}

async function connect(serverName?: string) {
  const configs = await loadServerConfigs()

  if (!serverName) {
    console.log(`Servers:\n`)
    for (const [name, config] of Object.entries(configs)) {
      const schemaPath = join(SCHEMAS_DIR, `${name}.json`)
      const connected = existsSync(schemaPath)
      if (connected) {
        const tools = await Bun.file(schemaPath).json()
        console.log(`  ${name.padEnd(14)} ✓ ${String(tools.length).padStart(2)} tools   ${config.description}`)
      } else {
        console.log(`  ${name.padEnd(14)} ○            ${config.description}`)
      }
    }
    console.log(`\nRun "jig connect <name>" to connect a server.`)
    return
  }

  const { getServerConfig } = await import("./mcp/config.js")
  const { connectServer, discoverTools } = await import("./mcp/client.js")

  console.log(`Connecting to ${serverName}...`)
  const config = await getServerConfig(serverName)
  const connection = await connectServer(serverName, config)
  const tools = await discoverTools(connection)

  console.log(`${tools.length} tools discovered:`)
  for (const tool of tools) {
    console.log(`  ${tool.name}`)
  }

  // Regenerate types + connection modules
  console.log(``)
  const typegen = Bun.spawn(["bun", "run", "src/mcp/typegen.ts"], {
    cwd: PROJECT_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  })
  await typegen.exited

  console.log(`\n${serverName} is ready.`)
  process.exit(0)
}

function exec(path: string) {
  return Bun.spawn(["bun", "run", path], {
    cwd: PROJECT_ROOT, stdin: "inherit", stdout: "inherit", stderr: "inherit", env: process.env,
  })
}

async function runJig(name?: string, entity?: string) {
  const jigsDir = join(PROJECT_ROOT, "jigs")
  const jigs = discoverJigs(jigsDir)

  if (!name) {
    console.log(`Available jigs:\n`)
    for (const [jig, entities] of jigs) {
      console.log(entities.length ? `  ${jig}  [${entities.join(", ")}]` : `  ${jig}`)
    }
    console.log(`\nRun "jig run <name>" or "jig run <name> <entity>"`)
    return
  }

  if (!jigs.has(name)) { console.error(`Jig not found: ${name}`); process.exit(1) }
  const entities = jigs.get(name)!

  // Single-instance
  if (entities.length === 0) {
    process.exit(await exec(join(jigsDir, `${name}.ts`)).exited)
  }

  // Grouped — no entity specified
  if (!entity) {
    console.log(`${name} entities: ${entities.join(", ")}`)
    console.log(`\nRun "jig run ${name} <entity>" or "jig run ${name} all"`)
    return
  }

  // Grouped — run all
  if (entity === "all") {
    for (const e of entities) {
      console.log(`\n--- ${name}/${e} ---`)
      await exec(join(jigsDir, name, `${e}.ts`)).exited
    }
    process.exit(0)
  }

  // Grouped — run one
  if (!entities.includes(entity)) { console.error(`Entity not found: ${name}/${entity}`); process.exit(1) }
  process.exit(await exec(join(jigsDir, name, `${entity}.ts`)).exited)
}

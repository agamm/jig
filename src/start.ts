/**
 * jig start — launches API server + Next.js dashboard.
 *
 * Bun API server runs on an internal port (handles /api/*).
 * Next.js runs on the user-facing port and rewrites /api/* to the Bun server.
 * Single URL for the user, no CORS.
 */
import { join } from "path"
import { existsSync } from "fs"
import { createInterface } from "node:readline/promises"
import { createApiServer } from "./server.js"

const PROJECT_ROOT = join(import.meta.dir, "..")
const DASHBOARD_DIR = join(PROJECT_ROOT, "dashboard")

/** Check if a port is free by briefly listening, then closing. */
async function isPortFree(port: number): Promise<boolean> {
  try {
    const server = Bun.serve({ port, fetch: () => new Response("") })
    server.stop(true)
    return true
  } catch {
    return false
  }
}

/** Find the PID using a port (macOS/Linux). Returns null if not found. */
async function findPidOnPort(port: number): Promise<number | null> {
  try {
    const proc = Bun.spawn(["lsof", "-ti", `TCP:${port}`, "-sTCP:LISTEN"], { stdout: "pipe", stderr: "pipe" })
    const text = await new Response(proc.stdout).text()
    await proc.exited
    const pid = parseInt(text.trim().split("\n")[0])
    return isNaN(pid) ? null : pid
  } catch {
    return null
  }
}

/** Ensure a port is available — ask user to kill the occupier if needed. */
async function ensurePort(port: number): Promise<number> {
  if (await isPortFree(port)) return port

  const pid = await findPidOnPort(port)
  if (pid) {
    console.log(`\n  Port ${port} is in use by PID ${pid}.`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`  Kill it and continue? [Y/n] `)
    rl.close()

    if (!answer || answer.toLowerCase().startsWith("y")) {
      process.kill(pid, "SIGTERM")
      // Wait briefly for the process to release the port
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300))
        if (await isPortFree(port)) return port
      }
      console.log(`  Could not free port ${port}, finding another...`)
    }
  } else {
    console.log(`\n  Port ${port} is in use.`)
  }

  // Fall back to finding a free port
  for (let p = port + 1; p < port + 20; p++) {
    if (await isPortFree(p)) {
      console.log(`  Using port ${p} instead.`)
      return p
    }
  }
  throw new Error(`No free port found near ${port}`)
}

/** Try creating the API server, scanning ports if needed. */
function tryServe(start: number): ReturnType<typeof createApiServer> {
  for (let port = start; port < start + 20; port++) {
    try {
      return createApiServer(port)
    } catch {
      continue
    }
  }
  throw new Error(`No free port found starting from ${start}`)
}

export async function startServer(options?: { port?: number }) {
  // Auto-install dashboard deps if missing
  if (!existsSync(join(DASHBOARD_DIR, "node_modules"))) {
    console.log("Installing dashboard dependencies...")
    const install = Bun.spawn(["pnpm", "install"], { cwd: DASHBOARD_DIR, stdout: "inherit", stderr: "inherit" })
    const code = await install.exited
    if (code !== 0) {
      console.error("Failed to install dashboard dependencies. Is pnpm installed? (npm install -g pnpm)")
      process.exit(1)
    }
  }

  // Verify connection files are up-to-date (regenerate if they reference missing modules)
  const connectionsDir = join(PROJECT_ROOT, ".jig/connections")
  if (existsSync(connectionsDir)) {
    const indexFile = join(connectionsDir, "index.ts")
    if (existsSync(indexFile)) {
      const { readFileSync, readdirSync } = await import("fs")
      const files = readdirSync(connectionsDir).filter(f => f.endsWith(".ts") && f !== "index.ts")
      for (const file of files) {
        const content = readFileSync(join(connectionsDir, file), "utf-8")
        if (content.includes("sdk/connections")) {
          console.log(`Stale connection files detected. Regenerating...`)
          const regen = Bun.spawn(["bun", "run", "src/mcp/typegen.ts"], { cwd: PROJECT_ROOT, stdout: "inherit", stderr: "inherit" })
          await regen.exited
          break
        }
      }
    }
  }

  const envPort = parseInt(process.env.PORT ?? "0")
  const preferredPort = options?.port ?? (envPort || 3141)

  // 1. Ensure dashboard port is available
  const userPort = await ensurePort(preferredPort)

  // 2. Start Bun API server on an internal port
  const apiServer = tryServe(4173)
  const apiPort = apiServer.port

  // 3. Start Next.js on the free user-facing port
  const nextProcess = Bun.spawn(["pnpm", "run", "dev", "--port", String(userPort)], {
    cwd: DASHBOARD_DIR,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, JIG_API_PORT: String(apiPort) },
  })

  console.log(`\n  jig dashboard: http://localhost:${userPort}`)
  console.log(`  jig api:       http://localhost:${apiPort} (internal)\n`)

  // 4. Open browser after Next.js is ready
  setTimeout(async () => {
    try {
      const open = (await import("open")).default
      await open(`http://localhost:${userPort}`)
    } catch {}
  }, 2000)

  // 5. Clean shutdown
  const cleanup = () => {
    nextProcess.kill()
    apiServer.stop(true)
    process.exit(0)
  }
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  // Keep alive until Next.js exits
  await nextProcess.exited
}

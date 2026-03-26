/**
 * jig start — launches API server + Next.js dashboard.
 *
 * Bun API server runs on an internal port (handles /api/*).
 * Next.js runs on the user-facing port and rewrites /api/* to the Bun server.
 * Single URL for the user, no CORS.
 */
import { join } from "path"
import { createApiServer } from "./server.js"

const PROJECT_ROOT = join(import.meta.dir, "..")
const DASHBOARD_DIR = join(PROJECT_ROOT, "dashboard")

/** Try ports starting from `start` until one works. */
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
  const envPort = parseInt(process.env.PORT ?? "0")
  const userPort = options?.port ?? (envPort || 3141)

  // 1. Start Bun API server on an internal port
  const apiServer = tryServe(4173)
  const apiPort = apiServer.port

  // 2. Start Next.js on user-facing port, with API port for rewrites
  const nextProcess = Bun.spawn(["pnpm", "run", "dev", "--port", String(userPort)], {
    cwd: DASHBOARD_DIR,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, JIG_API_PORT: String(apiPort) },
  })

  console.log(`\n  jig dashboard: http://localhost:${userPort}`)
  console.log(`  jig api:       http://localhost:${apiPort} (internal)\n`)

  // 3. Open browser after Next.js is ready
  setTimeout(async () => {
    try {
      const open = (await import("open")).default
      await open(`http://localhost:${userPort}`)
    } catch {}
  }, 2000)

  // 4. Clean shutdown
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

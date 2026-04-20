/**
 * jig start — launches API server + Next.js dashboard.
 *
 * Bun API server runs on an internal port (handles /api/*).
 * Next.js runs on the user-facing port and rewrites /api/* to the Bun server.
 * Single URL for the user, no CORS.
 *
 * Two modes:
 *   - local: `next dev`, auto-open browser, interactive port-kill prompt.
 *   - service (Railway/Fly): lazy dashboard build, `next start` in
 *     production mode, no browser, bind to process.env.PORT.
 */
import { existsSync } from "fs"
import { createInterface } from "node:readline/promises"
import { createApiServer } from "./server.js"
import { CONNECTIONS_DIR, DASHBOARD_DIR, PROJECT_ROOT } from "./config/paths.js"
import { resetSessionLog } from "./debug/session-log.js"
import { startScheduler } from "./scheduler/index.js"
import { isServiceMode } from "./config/runtime.js"

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

/** Local-mode only: ensure a port is available, ask user to kill if needed. */
async function ensurePortLocal(port: number): Promise<number> {
  if (await isPortFree(port)) return port

  const pid = await findPidOnPort(port)
  if (pid) {
    console.log(`\n  Port ${port} is in use by PID ${pid}.`)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    const answer = await rl.question(`  Kill it and continue? [Y/n] `)
    rl.close()

    if (!answer || answer.toLowerCase().startsWith("y")) {
      process.kill(pid, "SIGTERM")
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 300))
        if (await isPortFree(port)) return port
      }
      console.log(`  Could not free port ${port}, finding another...`)
    }
  } else {
    console.log(`\n  Port ${port} is in use.`)
  }

  for (let p = port + 1; p < port + 20; p++) {
    if (await isPortFree(p)) {
      console.log(`  Using port ${p} instead.`)
      return p
    }
  }
  throw new Error(`No free port found near ${port}`)
}

/**
 * Try creating the API server, scanning ports if needed. Only port-binding
 * errors get the fallback treatment; anything else (DB open failure,
 * migration error, etc.) is propagated immediately so the real cause
 * reaches the container logs instead of being masked as "no free port".
 */
function tryServe(start: number): ReturnType<typeof createApiServer> {
  let firstPortError: unknown = null
  for (let port = start; port < start + 20; port++) {
    try {
      return createApiServer(port)
    } catch (e: any) {
      const msg = e?.message ?? String(e)
      if (/EADDRINUSE|address in use|listen .* failed/i.test(msg)) {
        firstPortError ??= e
        continue
      }
      throw e
    }
  }
  throw firstPortError ?? new Error(`No free port found starting from ${start}`)
}

/**
 * Resolve the `pnpm` binary, installing it via `bun install -g pnpm` if the
 * container doesn't ship one. Matches CLAUDE.md's "dashboard uses pnpm" rule
 * so node_modules resolution is identical between dev and prod.
 */
async function commandV(name: string): Promise<string | null> {
  try {
    const proc = Bun.spawn(["sh", "-c", `command -v ${name}`], { stdout: "pipe", stderr: "pipe" })
    const out = await new Response(proc.stdout).text()
    await proc.exited
    if (proc.exitCode === 0 && out.trim()) return out.trim()
  } catch {}
  return null
}

async function resolvePnpm(): Promise<string> {
  const fromPath = await commandV("pnpm")
  if (fromPath) return fromPath

  console.log("pnpm not found — installing globally via bun...")
  const install = Bun.spawn(["bun", "install", "-g", "pnpm"], { stdout: "inherit", stderr: "inherit" })
  const code = await install.exited
  if (code !== 0) throw new Error("bun install -g pnpm failed")

  // After install, try PATH again, then fall back to known global bin dirs.
  const afterPath = await commandV("pnpm")
  if (afterPath) return afterPath
  const candidates = [
    process.env.BUN_INSTALL ? `${process.env.BUN_INSTALL}/bin/pnpm` : null,
    `${process.env.HOME ?? ""}/.bun/bin/pnpm`,
  ].filter((p): p is string => Boolean(p))
  for (const p of candidates) if (existsSync(p)) return p
  throw new Error("Installed pnpm but couldn't locate the binary")
}

/** Install dashboard node_modules if missing. */
async function ensureDashboardInstalled(): Promise<void> {
  if (existsSync(`${DASHBOARD_DIR}/node_modules`)) return
  const pnpm = await resolvePnpm()
  console.log("Installing dashboard dependencies (pnpm)...")
  const install = Bun.spawn([pnpm, "install", "--prefer-offline"], {
    cwd: DASHBOARD_DIR,
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await install.exited
  if (code !== 0) {
    throw new Error("Failed to install dashboard dependencies via pnpm.")
  }
}

/** Build dashboard for production if no .next output exists. */
async function ensureDashboardBuilt(): Promise<void> {
  if (existsSync(`${DASHBOARD_DIR}/.next/standalone`) || existsSync(`${DASHBOARD_DIR}/.next/BUILD_ID`)) return
  console.log("Building dashboard for production...")
  // Invoke the locally-installed `next` binary directly — avoids depending on
  // pnpm being available in the container.
  const nextBin = `${DASHBOARD_DIR}/node_modules/.bin/next`
  if (!existsSync(nextBin)) {
    throw new Error(`next binary not found at ${nextBin}. Dashboard install may have failed.`)
  }
  const build = Bun.spawn([nextBin, "build"], {
    cwd: DASHBOARD_DIR,
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await build.exited
  if (code !== 0) {
    throw new Error("Dashboard build failed")
  }
}

export async function startServer(options?: { port?: number }) {
  await resetSessionLog()

  await ensureDashboardInstalled()

  // Verify connection files are up-to-date (regenerate if they reference missing modules)
  const connectionsDir = CONNECTIONS_DIR
  if (existsSync(connectionsDir)) {
    const indexFile = `${connectionsDir}/index.ts`
    if (existsSync(indexFile)) {
      const { readFileSync, readdirSync } = await import("fs")
      const files = readdirSync(connectionsDir).filter(f => f.endsWith(".ts") && f !== "index.ts")
      for (const file of files) {
        const content = readFileSync(`${connectionsDir}/${file}`, "utf-8")
        if (content.includes("sdk/connections")) {
          console.log(`Stale connection files detected. Regenerating...`)
          const regen = Bun.spawn(["bun", "run", "src/mcp/typegen.ts"], { cwd: PROJECT_ROOT, stdout: "inherit", stderr: "inherit" })
          await regen.exited
          break
        }
      }
    }
  }

  const service = isServiceMode()
  const envPort = parseInt(process.env.PORT ?? "0")
  const preferredPort = options?.port ?? (envPort || 3141)

  // 1. Resolve the user-facing port
  let userPort: number
  if (service) {
    // Trust the platform; bind exactly to $PORT. No interactive prompts.
    if (!envPort) throw new Error("Service mode detected but $PORT is not set. Check platform config.")
    userPort = envPort
  } else {
    userPort = await ensurePortLocal(preferredPort)
  }
  process.env.JIG_DASHBOARD_PORT = String(userPort)

  // 2. Start Bun API server on an internal port
  const apiServer = tryServe(4173)
  const apiPort = apiServer.port
  const scheduler = await startScheduler().catch((e: unknown) => {
    console.error("[scheduler] failed to start:", e)
    return null
  })

  // 3. Start Next.js. In service mode: build + `next start`. In local: `next dev`.
  // Invoke the locally-installed `next` binary directly — portable across pnpm/bun installs.
  const nextBin = `${DASHBOARD_DIR}/node_modules/.bin/next`
  if (!existsSync(nextBin)) {
    throw new Error(`next binary missing at ${nextBin} after install. Check dashboard install logs.`)
  }
  let nextProcess: ReturnType<typeof Bun.spawn>
  if (service) {
    await ensureDashboardBuilt()
    nextProcess = Bun.spawn(
      [nextBin, "start", "--hostname", "0.0.0.0", "--port", String(userPort)],
      {
        cwd: DASHBOARD_DIR,
        stdout: "inherit",
        stderr: "inherit",
        env: { ...process.env, JIG_API_PORT: String(apiPort) },
      },
    )
  } else {
    nextProcess = Bun.spawn([nextBin, "dev", "--port", String(userPort)], {
      cwd: DASHBOARD_DIR,
      stdout: "inherit",
      stderr: "inherit",
      env: { ...process.env, JIG_API_PORT: String(apiPort) },
    })
  }

  if (service) {
    console.log(`\n  jig dashboard: http://0.0.0.0:${userPort} (service mode)`)
    console.log(`  jig api:       http://localhost:${apiPort} (internal)\n`)
  } else {
    console.log(`\n  jig dashboard: http://localhost:${userPort}`)
    console.log(`  jig api:       http://localhost:${apiPort} (internal)\n`)
  }

  // 4. Open browser on local only
  if (!service) {
    setTimeout(async () => {
      try {
        const open = (await import("open")).default
        await open(`http://localhost:${userPort}`)
      } catch {}
    }, 2000)
  }

  // 5. Clean shutdown
  const cleanup = async () => {
    const { closeAllConnections } = await import("./mcp/client.js")
    await closeAllConnections()
    scheduler?.stop()
    nextProcess.kill()
    apiServer.stop(true)
    process.exit(0)
  }
  process.on("SIGINT", cleanup)
  process.on("SIGTERM", cleanup)

  // Keep alive until Next.js exits
  await nextProcess.exited
}

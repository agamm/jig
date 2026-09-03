#!/usr/bin/env bun
/**
 * Jig CLI — thin glue that wires terminal I/O to reusable modules.
 *
 * The connect flow emits structured ConnectEvents; this file renders them as
 * text. The dashboard renders the same events as UI components.
 */
process.env.JIG_LOG_SOURCE = process.env.JIG_LOG_SOURCE ?? "cli"
import "./server/log-buffer.js" // side-effect: captures console.* into the shared SQLite logs table
import { join } from "path"
import { createInterface } from "node:readline/promises"
import { PROJECT_ROOT } from "./config/paths.js"
import { runConnectFlow, type ConnectEvent, type ConnectIO } from "../shared/connect-flow.js"
import type { ConnectConnectionResponse, Connection } from "../shared/api.js"
import { splitCliArgs } from "./domain/cli-args.js"

const API_PORT = parseInt(process.env.PORT ?? "3141")
const API_BASE = `http://localhost:${API_PORT}`

const rawArgs = process.argv.slice(2)
const { dryRun, command, rest } = splitCliArgs(rawArgs)

if (dryRun) {
  const { setDryRun } = await import("./sdk/dryrun.js")
  setDryRun(true)
}

// ---------------------------------------------------------------------------
// CLI renderer — turns structured events into terminal output
// ---------------------------------------------------------------------------

function renderEvent(event: ConnectEvent): void {
  switch (event.type) {
    case "error":
      console.error(event.message)
      if (event.details?.suggestion) console.error(`Try: ${event.details.suggestion}`)
      if (event.details?.commands) {
        for (const cmd of event.details.commands) console.error(`  ${cmd}`)
      }
      break
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
    case "setup-instructions":
      console.log(`\n${event.message}\n`)
      break
    case "awaiting-oauth":
      // Connect no longer blocks the HTTP request through the browser dance
      // (that got killed by the server idleTimeout), so this fires in both
      // modes now. Local mode also auto-opens the browser server-side; the
      // background connect completes against the running server.
      console.log(
        event.browserOpened
          ? `\nAuthorizing ${event.server} in your browser… if nothing opened, visit:\n  ${event.authorizationUrl}\n`
          : `\nOpen this URL in any browser to authorize ${event.server}:\n  ${event.authorizationUrl}\n`,
      )
      break
  }
}

function makeIO(): ConnectIO {
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

async function agentCommand(instruction: string, jigId?: string): Promise<void> {
  await ensureServer()

  // Start agent session
  const startRes = await fetch(`${API_BASE}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ instruction, jigId }),
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
      await handleRun(rest[0])
      break

    case "new": {
      const desc = rest.join(" ") || await io.ask("What should this jig do?")
      console.log("")
      await agentCommand(desc)
      process.exit(0)
      break
    }

    case "edit": {
      const [name] = rest
      if (!name) { io.emit({ type: "error", code: "usage", message: "Usage: jig edit <name>" }); process.exit(1) }
      const instruction = await io.ask("What should change?")
      console.log("")
      await agentCommand(instruction, name)
      process.exit(0)
      break
    }

    case "start": {
      const { startServer } = await import("./start.js")
      await startServer()
      break
    }

    case "versions": {
      const [name] = rest
      if (!name) { io.emit({ type: "error", code: "usage", message: "Usage: jig versions <name>" }); process.exit(1) }
      const { listAllVersions, getJigRow } = await import("./services/jig-store.js")
      const jig = getJigRow(name)
      if (!jig) { console.error(`Jig not found: ${name}`); process.exit(1); }
      const versions = listAllVersions(name)
      if (versions.length === 0) { console.log("(no versions)"); break }
      for (const v of versions) {
        const tag = v.id === jig.active_version_id ? " ACTIVE" : v.id === jig.pending_version_id ? " PENDING" : ""
        const date = new Date(v.createdAt).toISOString().slice(0, 16).replace("T", " ")
        console.log(`v${String(v.id).padStart(4)}  ${date}  ${v.author.padEnd(8)}${tag.padEnd(8)}  ${v.message ?? ""}`)
      }
      process.exit(0)
      break
    }

    case "restore": {
      const [name, versionArg] = rest
      const versionId = versionArg?.startsWith("v") ? parseInt(versionArg.slice(1)) : parseInt(versionArg)
      if (!name || !Number.isFinite(versionId)) {
        io.emit({ type: "error", code: "usage", message: "Usage: jig restore <name> <versionId>" })
        process.exit(1)
      }
      const { restoreVersion, getPending } = await import("./services/jig-store.js")
      if (getPending(name)) {
        console.error(`A pending change already exists for ${name}. Approve or discard it first.`)
        process.exit(1)
      }
      const { pendingVersionId } = restoreVersion({ jigId: name, versionId, author: "cli" })
      console.log(`Restored v${versionId} as pending v${pendingVersionId}. Use 'jig pending ${name}' to review and approve.`)
      process.exit(0)
      break
    }

    case "pending": {
      const [name, action] = rest
      if (!name) { io.emit({ type: "error", code: "usage", message: "Usage: jig pending <name> [approve|discard]" }); process.exit(1) }
      const { getPending, approvePending, discardPending } = await import("./services/jig-store.js")
      const pending = getPending(name)
      if (!pending) { console.log(`No pending changes for ${name}.`); break }

      if (action === "approve") {
        approvePending(name)
        console.log(`Approved pending changes for ${name} (now active).`)
        process.exit(0)
        break
      }
      if (action === "discard") {
        discardPending(name)
        console.log(`Discarded pending changes for ${name}.`)
        process.exit(0)
        break
      }
      // Default: show diff
      console.log(`Pending changes for ${name}: +${pending.addedLines} −${pending.removedLines} lines\n`)
      console.log(pending.diff)
      console.log(`\nRun 'jig pending ${name} approve' to apply, or 'jig pending ${name} discard' to drop.`)
      process.exit(0)
      break
    }

    case "setup": {
      const { runSetup } = await import("./cli-setup/index.js")
      await runSetup(rest, async () => {
        await ensureServer()
        return API_BASE
      })
      process.exit(0)
      break
    }

    case "backup": {
      const { runBackupArgs } = await import("./cli-backup/index.js")
      await runBackupArgs(rest)
      process.exit(0)
      break
    }

    case "deploy": {
      const { runDeployArgs } = await import("./cli-deploy/index.js")
      await runDeployArgs(rest)
      break
    }

    case "pair": {
      const { runPair } = await import("./cli-remote/pair.js")
      await runPair(rest)
      break
    }

    case "unlock": {
      const { resolveActiveRemote, listRemotes } = await import("./cli-remote/manifest.js")
      const { ensureUnlocked } = await import("./cli-remote/unlock.js")
      const handle = rest.find((a) => !a.startsWith("--"))
      const passwordFlag = rest.find((a) => a.startsWith("--password="))?.slice("--password=".length)
      if (listRemotes().length === 0) {
        console.error("No deployed instances. Run `jig deploy` first.")
        process.exitCode = 1
        break
      }
      const remote = resolveActiveRemote(handle)
      const ok = await ensureUnlocked(remote, { password: passwordFlag })
      if (!ok) process.exitCode = 1
      break
    }

    case "doctor": {
      const { runDoctor } = await import("./cli-doctor/index.js")
      const jsonFlag = rest.includes("--json")
      const positional = rest.find((a) => !a.startsWith("--"))
      await runDoctor({ handle: positional, json: jsonFlag })
      break
    }

    case "debug": {
      const { runDebug } = await import("./cli-debug/index.js")
      await runDebug(rest)
      break
    }

    case "update": {
      // Prefer remote update when a manifest exists; otherwise fall back to
      // the local git-pull path so developers working from a clone are
      // unaffected.
      const { listRemotes } = await import("./cli-remote/manifest.js")
      if (listRemotes().length > 0) {
        const { runUpdate } = await import("./cli-remote/update.js")
        await runUpdate(rest[0])
      } else {
        await update()
      }
      break
    }

    default:
      console.log(`jig — AI workflow automation\n`)
      console.log(`Commands:`)
      console.log(`  jig start              Start dashboard + API server`)
      console.log(`  jig setup [handle]     Guided setup: models, alerts, connections (--railway | --local)`)
  console.log(`  jig connect [server]   List servers or connect one`)
      console.log(`  jig run <name> [args]  Run a jig`)
      console.log(`  jig new [description]  AI generates a new jig`)
      console.log(`  jig edit <name> [ent]  AI modifies an existing jig`)
      console.log(`  jig versions <name>    List versions for a jig`)
      console.log(`  jig restore <name> <v> Restore version <v> as a pending change`)
      console.log(`  jig pending <name>     Show pending diff; append 'approve' or 'discard'`)
      console.log(`  jig backup             Write a .zip of jigs, connections and settings`)
      console.log(`  jig backup restore <f> Restore from a backup .zip (--dry-run to preview)`)
      console.log(`  jig deploy             Provision a new Railway-hosted instance (interactive)`)
      console.log(`  jig deploy --update    Redeploy current code to the linked Railway project`)
      console.log(`  jig update [handle]    Update a deployed jig to the latest tag (rolls back on failure)`)
      console.log(`  jig doctor [handle]    Health-check deployed instances`)
      console.log(`  jig pair <code>        Cache a CLI session from a dashboard pairing code`)
      console.log(`  jig unlock [handle]    Unlock a deployed instance after a restart (hidden prompt)`)
      console.log(`  jig debug <sub>        Remote runs, logs, and jig pull/push (see "jig debug")`)
      break
  }
} catch (e: any) {
  if (e?.message) console.error(e.message)
  process.exit(1)
}

// ---------------------------------------------------------------------------
// update — pull latest from upstream, reinstall deps
// ---------------------------------------------------------------------------

async function update() {
  const runInherited = async (args: string[], cwd: string): Promise<number> => {
    const proc = Bun.spawn(args, { cwd, stdout: "inherit", stderr: "inherit" })
    return await proc.exited
  }

  const runText = async (args: string[], cwd: string): Promise<string> => {
    const proc = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" })
    const [stdout] = await Promise.all([
      new Response(proc.stdout).text(),
      proc.exited,
    ])
    return stdout
  }

  // Check if upstream remote exists
  const remoteCheck = Bun.spawn(["git", "remote", "get-url", "upstream"], { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" })
  await remoteCheck.exited
  if (remoteCheck.exitCode !== 0) {
    console.log("No upstream remote found — this is the upstream repo.")
    console.log("Use git pull directly.")
    return
  }

  console.log("Updating from upstream...\n")

  // Stash any local changes (lockfile diffs, etc.)
  const status = await runText(["git", "status", "--porcelain"], PROJECT_ROOT)
  const hasChanges = status.trim().length > 0
  let stashRef: string | null = null

  if (hasChanges) {
    console.log("  Stashing local changes...")
    const stashLabel = `jig-update-${Date.now()}`
    const stashCode = await runInherited(["git", "stash", "push", "--include-untracked", "--message", stashLabel], PROJECT_ROOT)
    if (stashCode !== 0) {
      console.error("Failed to stash changes.")
      return
    }

    const stashList = await runText(["git", "stash", "list", "--format=%gd%x00%s"], PROJECT_ROOT)
    stashRef = stashList
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("\0"))
      .find(([, message]) => message === stashLabel)?.[0] ?? null

    if (!stashRef) {
      console.error("Failed to locate the temporary stash created for update.")
      return
    }
  }

  // Pull with rebase
  console.log("  Pulling upstream main...")
  const pullCode = await runInherited(["git", "pull", "upstream", "main", "--rebase"], PROJECT_ROOT)

  if (pullCode !== 0) {
    console.error("\nPull failed. Resolve conflicts and try again.")
    if (stashRef) {
      console.error(`Your local changes are stored in ${stashRef}. Re-apply them after resolving the pull/rebase.`)
    }
    return
  }

  // Restore stash only after a successful pull. Use apply+drop so the stash is
  // preserved if re-applying local changes conflicts.
  if (stashRef) {
    console.log("  Restoring local changes...")
    const applyCode = await runInherited(["git", "stash", "apply", "--index", stashRef], PROJECT_ROOT)
    if (applyCode !== 0) {
      console.error(`\nUpdate completed, but restoring local changes failed. Your stash was kept as ${stashRef}.`)
      console.error(`Resolve the conflicts, then drop it manually with: git stash drop ${stashRef}`)
      return
    }

    const dropCode = await runInherited(["git", "stash", "drop", stashRef], PROJECT_ROOT)
    if (dropCode !== 0) {
      console.error(`\nUpdated and restored local changes, but failed to drop ${stashRef}.`)
      console.error(`You can remove it manually with: git stash drop ${stashRef}`)
      return
    }
  }

  // Reinstall deps
  console.log("  Installing dependencies...")
  const installCode = await runInherited(["pnpm", "install"], join(PROJECT_ROOT, "dashboard"))
  if (installCode !== 0) {
    console.error("\nDependencies failed to install. Fix the install issue and run `pnpm install` in dashboard.")
    return
  }

  console.log("\n  ✓ Updated successfully.\n")
}

// ---------------------------------------------------------------------------
// connect — uses structured events
// ---------------------------------------------------------------------------

async function connect(serverName: string | undefined, io: ConnectIO) {
  await ensureServer()

  const fetchApiJson = async <T>(path: string, init?: RequestInit): Promise<T> => {
    const res = await fetch(`${API_BASE}${path}`, init)
    if (!res.ok) {
      const error = await res.json().catch(() => ({ error: `HTTP ${res.status}` }))
      throw new Error(error.error ?? `HTTP ${res.status}`)
    }
    return res.json() as Promise<T>
  }

  await runConnectFlow(serverName, io, {
    listConnections: () => fetchApiJson<Connection[]>("/api/connections"),
    connect: (name, credentials) => fetchApiJson<ConnectConnectionResponse>(
      `/api/connections/${encodeURIComponent(name)}/connect`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(credentials ? { credentials } : {}),
      }
    ),
  })
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function runJigFile(path: string, jigId: string) {
  const { runJig, persist } = await import("./runner.js")
  const { openDb, insertRun } = await import("./db.js")

  const db = openDb()

  const isDry = dryRun
  const runId = isDry ? -1 : insertRun(jigId)
  const start = Date.now()
  const persistHandler = !isDry ? persist(runId, start) : null

  // jigId matters beyond logging: ctx.memory and ctx.remind are scoped by it,
  // and ctx.email needs it to mint a reply token. Omitting it made a CLI run
  // behave differently from the same jig run by the scheduler or dashboard.
  const result = await runJig(path, {}, (event) => {
    if (event.type === "error") console.error(event.message)
    persistHandler?.(event)
  }, { jigId })

  if (result.skipped && !isDry) {
    db.prepare(`DELETE FROM run_steps WHERE run_id = ?`).run(runId)
    db.prepare(`DELETE FROM runs WHERE id = ?`).run(runId)
  }

  if (result.error) process.exit(1)
}

/**
 * Runs the jig's APPROVED ACTIVE VERSION from the store — the same source the
 * dashboard and the scheduler execute. Reading `jigs/<name>.ts` off disk instead
 * (as this did pre-v12) meant `jig run` could silently execute code that had
 * been superseded, rolled back, or never approved.
 */
async function handleRun(name: string | undefined) {
  const { listJigs } = await import("./services/jig-store.js")

  if (!name) {
    const jigs = listJigs().filter((jig) => jig.activeVersionId != null)
    if (jigs.length === 0) {
      console.log(`No jigs yet. Create one with "jig new <description>".`)
      return
    }
    console.log("Available jigs:\n")
    for (const jig of jigs) console.log(`  ${jig.id}`)
    console.log(`\nRun "jig run <name>"`)
    return
  }

  const { materializeActiveVersion } = await import("./services/jig-runtime.js")
  const materialized = await materializeActiveVersion(name)
  if (!materialized) {
    console.error(`Jig not found (or has no approved version): ${name}`)
    process.exit(1)
  }

  // Same per-jig preflight the server runs, instead of the old blanket
  // "is anything connected at all" check.
  const { missingConnectionsForJig } = await import("./services/connection-preflight.js")
  const missing = missingConnectionsForJig(materialized.path)
  if (missing.length > 0) {
    console.error(
      `${missing.length === 1 ? "Connection" : "Connections"} required: ${missing.join(", ")}.`
      + ` Run "jig connect <server>" first.`
    )
    process.exit(1)
  }

  await runJigFile(materialized.path, name)
}

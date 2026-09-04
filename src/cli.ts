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

async function agentCommand(instruction: string, jigId?: string, argv: string[] = []): Promise<void> {
  const { resolveAuthoringTarget } = await import("./cli-agent/target.js")
  let target
  try {
    target = resolveAuthoringTarget(argv, API_BASE)
  } catch (e: any) {
    console.error(e?.message ?? e)
    process.exit(1)
  }

  // Only stand up a local server when local is actually the target. Starting one
  // to author on a remote would be pure surprise.
  if (!target.remote) await ensureServer()
  console.log(`Authoring on ${target.label}.\n`)

  const { runAgentSession } = await import("./cli-agent/session.js")
  try {
    const id = await runAgentSession({ base: target.base, headers: target.headers, instruction, jigId })
    if (!id) {
      console.log("\nThe agent finished without producing a jig.")
      return
    }
    console.log(`\n✓ Jig: ${id}`)
    if (target.remote) {
      console.log(`  Review it:  jig debug pull ${id}`)
      console.log(`  Run it:     jig debug run ${id}`)
    } else {
      console.log(`  Review it:  jig pending ${id}`)
      console.log(`  Run it:     jig run ${id}`)
    }
  } catch (e: any) {
    console.error(`\n✗ ${e?.message ?? e}`)
    process.exit(1)
  }
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

try {
  switch (command) {
    case "connect":
      await connect(rest[0], io)
      break

    case "run": {
      // Same rule as new/edit: the instance you deployed, unless you say --local.
      const { resolveAuthoringTarget } = await import("./cli-agent/target.js")
      let runTarget
      try {
        runTarget = resolveAuthoringTarget(rest, API_BASE)
      } catch (e: any) {
        console.error(e?.message ?? e)
        process.exit(1)
      }
      if (runTarget.remote) {
        const { runRemoteJig } = await import("./cli-debug/index.js")
        await runRemoteJig(rest)
      } else {
        await handleRun(rest.find((a) => !a.startsWith("--")))
      }
      break
    }

    case "new": {
      const words = rest.filter((a) => !a.startsWith("--"))
      const desc = words.join(" ") || await io.ask("What should this jig do?")
      console.log("")
      await agentCommand(desc, undefined, rest)
      process.exit(0)
      break
    }

    case "edit": {
      const name = rest.find((a) => !a.startsWith("--"))
      if (!name) {
        io.emit({ type: "error", code: "usage", message: "Usage: jig edit <name> [--out=<file> | --file=<file>]" })
        process.exit(1)
      }

      // Three ways to change a jig, one command. `--out` exports the live code,
      // `--file` uploads code you wrote yourself, and with neither the authoring
      // agent does it from an instruction. These used to be `jig debug
      // pull/push`, which meant the same job had two names depending on where
      // the jig lived.
      const outFlag = rest.find((a) => a.startsWith("--out="))
      const fileFlag = rest.find((a) => a.startsWith("--file="))
      const { resolveAuthoringTarget } = await import("./cli-agent/target.js")
      let editTarget
      try {
        editTarget = resolveAuthoringTarget(rest, API_BASE)
      } catch (e: any) {
        console.error(e?.message ?? e)
        process.exit(1)
      }

      if (outFlag || fileFlag) {
        if (editTarget.remote) {
          const { pullRemoteJig, pushRemoteJig } = await import("./cli-debug/index.js")
          if (outFlag) await pullRemoteJig(rest)
          else await pushRemoteJig([name, fileFlag!.slice("--file=".length), ...rest.filter((a) => a.startsWith("--") && !a.startsWith("--file="))])
        } else {
          const { getActiveCode, writePending, approvePending } = await import("./services/jig-store.js")
          if (outFlag) {
            const code = getActiveCode(name)
            if (!code) { console.error(`No active code for ${name}.`); process.exit(1) }
            const dest = outFlag.slice("--out=".length)
            await Bun.write(dest, code)
            console.log(`Wrote ${name} to ${dest}.`)
          } else {
            const code = await Bun.file(fileFlag!.slice("--file=".length)).text()
            writePending({ jigId: name, code, author: "cli", message: "edited from a file" })
            if (rest.includes("--approve")) {
              approvePending(name)
              console.log(`✓ ${name} updated and active.`)
            } else {
              console.log(`✓ ${name} written as PENDING. Review: jig pending ${name}`)
            }
          }
        }
        process.exit(0)
      }

      const instruction = await io.ask("What should change?")
      console.log("")
      await agentCommand(instruction, name, rest)
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
      // `jig update` means "get the latest jig", and the thing in front of you
      // is this checkout: its code and the agent skills under .agents. Updating
      // the deployed instance is a second, explicit step, because redeploying
      // someone's running automation should never be a side effect.
      // A handle names an instance, which means the tag-based flow with its
      // health check and rollback. Keep it: it is the safe way to move a
      // production instance between releases.
      const handleArg = rest.find((a) => !a.startsWith("--"))
      if (handleArg) {
        const { runUpdate } = await import("./cli-remote/update.js")
        await runUpdate(handleArg)
        break
      }

      const updated = await update()
      if (rest.includes("--remote")) {
        if (!updated) {
          // Shipping a half-updated checkout to a running instance is worse
          // than not updating at all.
          console.error("Not redeploying: the local update did not finish cleanly.")
          process.exitCode = 1
          break
        }
        console.log("Pushing this checkout to your deployed instance...\n")
        const { listRemotes } = await import("./cli-remote/manifest.js")
        if (listRemotes().length === 0) {
          console.error("No deployed instances known here. Run `jig deploy` first.")
          process.exitCode = 1
          break
        }
        // Deploys what was just pulled, rather than the newest release TAG:
        // tags lag main, and `jig update --remote` should ship the code you can
        // see in front of you. `jig update <handle>` still does the tag flow.
        const { runDeployArgs } = await import("./cli-deploy/index.js")
        await runDeployArgs(["--update"])
      }
      break
    }

    default:
      console.log(`jig — AI workflow automation\n`)
      console.log(`Commands:`)
      console.log(`  jig start              Start dashboard + API server`)
      console.log(`  jig setup [handle]     Guided setup: models, alerts, connections (--railway | --local | --force)`)
  console.log(`  jig connect [server]   List servers or connect one`)
      console.log(`  jig run <name>         Run a jig on your deployed instance (--local for here)`)
      console.log(`  jig new [description]  AI generates a new jig (on your deployed instance; --local for here)`)
      console.log(`  jig edit <name>        AI modifies a jig; --out=<f> exports code, --file=<f> uploads it`)
      console.log(`  jig versions <name>    List versions for a jig`)
      console.log(`  jig restore <name> <v> Restore version <v> as a pending change`)
      console.log(`  jig pending <name>     Show pending diff; append 'approve' or 'discard'`)
      console.log(`  jig backup             Write a .zip of jigs, connections and settings`)
      console.log(`  jig backup restore <f> Restore from a backup .zip (--dry-run to preview)`)
      console.log(`  jig deploy             Provision a new Railway-hosted instance (interactive)`)
      console.log(`  jig deploy --update    Redeploy current code to the linked Railway project`)
      console.log(`  jig update             Pull the latest code and agent skills from GitHub`)
      console.log(`  jig update --remote    ...and redeploy your instance with it`)
      console.log(`  jig update <handle>    Move a deployed instance to the latest release tag`)
      console.log(`  jig doctor [handle]    Health-check deployed instances`)
      console.log(`  jig pair <code>        Cache a CLI session from a dashboard pairing code`)
      console.log(`  jig unlock [handle]    Unlock a deployed instance after a restart (hidden prompt)`)
      console.log(`  jig debug <sub>        Diagnostics: logs, connections, tool probes (see "jig debug")`)
      break
  }
} catch (e: any) {
  if (e?.message) console.error(e.message)
  process.exit(1)
}


// ---------------------------------------------------------------------------
// update — pull latest from upstream, reinstall deps
// ---------------------------------------------------------------------------

async function update(): Promise<boolean> {
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

  // A fork has `upstream`; a plain clone of the repo has only `origin`, and
  // refusing to update that one was wrong: "no upstream remote" is the normal
  // case for everyone who followed the README.
  const hasUpstream = async (name: string): Promise<boolean> => {
    const check = Bun.spawn(["git", "remote", "get-url", name], { cwd: PROJECT_ROOT, stdout: "pipe", stderr: "pipe" })
    await check.exited
    return check.exitCode === 0
  }
  const source = (await hasUpstream("upstream")) ? "upstream" : "origin"
  if (!(await hasUpstream(source))) {
    console.error("This checkout has no git remote to update from.")
    return false
  }

  // Remembered so the summary can say whether the agent skills moved, which is
  // the part a coding agent needs to know it should re-read.
  const skillsBefore = await runText(["git", "rev-parse", "HEAD:.agents"], PROJECT_ROOT).catch(() => "")

  console.log(`Updating from ${source}...\n`)

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
      return false
    }

    const stashList = await runText(["git", "stash", "list", "--format=%gd%x00%s"], PROJECT_ROOT)
    stashRef = stashList
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("\0"))
      // git records the subject as "On <branch>: <label>", not the bare label.
      // Comparing for equality never matched, so a stash was taken and then
      // orphaned: local changes vanished from the working tree.
      .find(([, message]) => message.includes(stashLabel))?.[0] ?? null

    if (!stashRef) {
      console.error("Stashed your local changes but could not find the stash to restore.")
      console.error("They are safe: `git stash list` and `git stash pop`.")
      return false
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
    return false
  }

  // Restore stash only after a successful pull. Use apply+drop so the stash is
  // preserved if re-applying local changes conflicts.
  if (stashRef) {
    console.log("  Restoring local changes...")
    const applyCode = await runInherited(["git", "stash", "apply", "--index", stashRef], PROJECT_ROOT)
    if (applyCode !== 0) {
      console.error(`\nUpdate completed, but restoring local changes failed. Your stash was kept as ${stashRef}.`)
      console.error(`Resolve the conflicts, then drop it manually with: git stash drop ${stashRef}`)
      return false
    }

    const dropCode = await runInherited(["git", "stash", "drop", stashRef], PROJECT_ROOT)
    if (dropCode !== 0) {
      console.error(`\nUpdated and restored local changes, but failed to drop ${stashRef}.`)
      console.error(`You can remove it manually with: git stash drop ${stashRef}`)
      return false
    }
  }

  // Reinstall deps
  console.log("  Installing dependencies...")
  const installCode = await runInherited(["pnpm", "install"], join(PROJECT_ROOT, "dashboard"))
  if (installCode !== 0) {
    console.error("\nDependencies failed to install. Fix the install issue and run `pnpm install` in dashboard.")
    return false
  }

  const skillsAfter = await runText(["git", "rev-parse", "HEAD:.agents"], PROJECT_ROOT).catch(() => "")
  const version = JSON.parse(await Bun.file(join(PROJECT_ROOT, "package.json")).text()).version

  console.log(`\n  ✓ Updated to ${version}.`)
  if (skillsBefore && skillsAfter && skillsBefore.trim() !== skillsAfter.trim()) {
    console.log("  The agent skills under .agents/skills changed. Re-read them before continuing.")
  }
  console.log("")
  return true
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

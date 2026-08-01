/**
 * `jig debug` — talk to a deployed jig from the CLI for debugging.
 *
 * Subcommands:
 *   - login [handle]            Cache an admin session cookie for the remote.
 *   - run <jigId> [handle]      Trigger a run, stream debug logs, exit on finish.
 *   - tail [handle]             Stream debug logs continuously (Ctrl-C to stop).
 *
 * Auth: POST /api/unlock returns an HMAC-signed cookie (30-day TTL). We stash
 * the cookie value in the remote manifest (file mode 0600) and replay it as
 * `Cookie: jig-admin=<value>` on subsequent admin-gated calls.
 *
 * Output: prints the same `[source] event …` headline the dashboard shows,
 * and for rows with a redacted JSON payload, prints the JSON indented below.
 * This is how Claude (or you) can see exactly what an agent / tool did on
 * the remote box.
 */
import { listRemotes, resolveActiveRemote, setSessionCookie, type RemoteManifest } from "../cli-remote/manifest.js"
import { readLocalLogHead, readLocalLogs } from "./local.js"
import { DB_PATH } from "../config/paths.js"
import type { ServerLogEntry, ServerLogsResponse, StartRunResponse, RunDetail } from "../../shared/api.js"

const COOKIE_NAME = "jig-admin"
const POLL_MS = 750
const RUN_TIMEOUT_MS = 10 * 60 * 1000
const PAYLOAD_MAX_LINES = 40
const DEFAULT_LOCAL_LIMIT = 100

// ---------------------------------------------------------------------------
// Subcommand entry point
// ---------------------------------------------------------------------------

export async function runDebug(args: string[]): Promise<void> {
  const sub = args[0]
  const rest = args.slice(1)

  if (sub === "login") return loginCmd(rest)
  if (sub === "run") return runCmd(rest)
  if (sub === "tail") return tailCmd(rest)

  console.log("Usage:")
  console.log("  jig debug login [handle]          Cache admin session cookie")
  console.log("  jig debug run <jigId> [handle]    Trigger a run and stream debug logs")
  console.log("  jig debug tail [handle]           Stream debug logs (Ctrl-C to stop)")
  console.log("")
  console.log("Auth:")
  console.log("  --password=<pw>        Provide password inline")
  console.log("  JIG_PASSWORD=<pw>      Or via env var")
  console.log("")
  console.log("Reading a locked instance (run inside the container, no password needed):")
  console.log("  railway ssh \"bun run src/cli.ts debug tail --local\"")
  console.log("  --local                Read the logs table off the volume, bypassing the API")
  console.log("  --limit=<n>            Rows to dump (default 100)")
  console.log("  --since=<seq>          Dump everything after this seq instead")
  console.log("  --follow               Keep polling after the dump")
  process.exit(sub ? 1 : 0)
}

// ---------------------------------------------------------------------------
// login
// ---------------------------------------------------------------------------

async function loginCmd(args: string[]): Promise<void> {
  const handle = positional(args)
  const remote = resolveRemoteOrExit(handle)
  const password = readPassword(args)
  if (!password) {
    console.error("Password required. Pass --password=<pw> or set JIG_PASSWORD env var.")
    process.exit(1)
  }

  const res = await fetch(`${remote.public_url}/api/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    console.error(`Unlock failed: ${res.status} ${body}`)
    process.exit(1)
  }
  const setCookie = res.headers.get("set-cookie") ?? ""
  const cookie = extractCookie(setCookie, COOKIE_NAME)
  if (!cookie) {
    console.error("Unlock succeeded but no session cookie returned. Server too old?")
    process.exit(1)
  }
  setSessionCookie(remote.handle, cookie)
  console.log(`Logged in to ${remote.handle} (${remote.public_url}). Session cached for 30 days.`)
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

async function runCmd(args: string[]): Promise<void> {
  const positionals = args.filter((a) => !a.startsWith("--"))
  const jigId = positionals[0]
  if (!jigId) {
    console.error("Usage: jig debug run <jigId> [handle]")
    process.exit(1)
  }
  const handle = positionals[1]
  const remote = resolveRemoteOrExit(handle)
  const cookie = remote.session_cookie
  if (!cookie) {
    console.error(`No session cookie cached. Run "jig debug login ${remote.handle}" first.`)
    process.exit(1)
  }
  const dryRun = args.includes("--dry-run")

  // Anchor at the current log head so we don't replay old entries.
  const startCursor = await fetchLogHead(remote, cookie)

  let started: StartRunResponse
  try {
    started = await postJson<StartRunResponse>(
      `${remote.public_url}/api/jigs/${encodeURIComponent(jigId)}/run`,
      cookie,
      { dryRun },
    )
  } catch (e: any) {
    console.error(`Failed to start run: ${e.message}`)
    process.exit(1)
  }
  console.log(`▶ ${jigId} started (runId=${started.runId}${dryRun ? ", dry-run" : ""}) on ${remote.handle}`)
  console.log("")

  const deadline = Date.now() + RUN_TIMEOUT_MS
  let cursor = startCursor
  while (Date.now() < deadline) {
    const next = await fetchLogs(remote, cookie, cursor).catch((e) => {
      console.error(`[poll error] ${e.message}`)
      return null
    })
    if (next && next.entries.length > 0) {
      cursor = next.entries[next.entries.length - 1].seq
      for (const entry of next.entries) printEntry(entry)
    }

    const status = await getRunStatus(remote, cookie, started.runId).catch(() => null)
    if (status && status.status !== "running") {
      // Drain any final rows that landed between the last poll and termination.
      const tail = await fetchLogs(remote, cookie, cursor).catch(() => null)
      if (tail) for (const entry of tail.entries) printEntry(entry)
      console.log("")
      console.log(`■ run ${started.runId} ${status.status}${status.error ? ` — ${status.error}` : ""}`)
      process.exit(status.status === "success" ? 0 : 1)
    }
    await sleep(POLL_MS)
  }
  console.error(`Timed out after ${RUN_TIMEOUT_MS / 1000}s waiting for run to finish.`)
  process.exit(2)
}

// ---------------------------------------------------------------------------
// tail
// ---------------------------------------------------------------------------

async function tailCmd(args: string[]): Promise<void> {
  if (args.includes("--local")) return tailLocalCmd(args)

  const handle = positional(args)
  const remote = resolveRemoteOrExit(handle)
  const cookie = remote.session_cookie
  if (!cookie) {
    console.error(`No session cookie cached. Run "jig debug login ${remote.handle}" first.`)
    process.exit(1)
  }
  const sinceArg = args.find((a) => a.startsWith("--since="))?.slice("--since=".length)
  let cursor = sinceArg ? Math.max(0, parseInt(sinceArg, 10) || 0) : await fetchLogHead(remote, cookie)

  console.log(`Tailing ${remote.handle} (${remote.public_url}) from seq ${cursor}. Ctrl-C to stop.`)
  for (;;) {
    const next = await fetchLogs(remote, cookie, cursor).catch((e) => {
      console.error(`[poll error] ${e.message}`)
      return null
    })
    if (next && next.entries.length > 0) {
      cursor = next.entries[next.entries.length - 1].seq
      for (const entry of next.entries) printEntry(entry)
    }
    await sleep(POLL_MS)
  }
}

// ---------------------------------------------------------------------------
// tail --local
// ---------------------------------------------------------------------------

/**
 * Read logs off the volume instead of the API. Meant to be run inside the
 * container (`railway ssh`), where it works even while the instance is locked
 * and the HTTP gate is returning 423.
 */
async function tailLocalCmd(args: string[]): Promise<void> {
  const sinceArg = numericFlag(args, "--since")
  const limit = numericFlag(args, "--limit") ?? DEFAULT_LOCAL_LIMIT
  const follow = args.includes("--follow")

  // Filter before slicing so --limit means "interesting lines shown", not
  // "rows scanned" — most rows are routing chatter the whitelist drops. The
  // table is capped at a few thousand rows, so reading it whole is cheap.
  const backlog = readLocalLogs(sinceArg ?? 0).filter(isInterestingForDebug)
  for (const entry of sinceArg !== undefined ? backlog : backlog.slice(-limit)) {
    printEntry(entry, rawEmit)
  }

  if (!follow) return
  let cursor = readLocalLogHead()
  rawEmit(`— following ${DB_PATH} from seq ${cursor}. Ctrl-C to stop.`)
  for (;;) {
    const next = readLocalLogs(cursor)
    if (next.length > 0) {
      cursor = next[next.length - 1].seq
      for (const entry of next) printEntry(entry, rawEmit)
    }
    await sleep(POLL_MS)
  }
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

function authHeaders(cookie: string): Record<string, string> {
  return { Cookie: `${COOKIE_NAME}=${cookie}` }
}

async function fetchLogHead(remote: RemoteManifest, cookie: string): Promise<number> {
  // since=very-large-seq returns an empty page; the existing log buffer caps at
  // 5000 retained rows so a fixed since=1e9 is safe. But we actually need the
  // current max — getLogs only returns rows with seq > since. So request all
  // recent rows and take the last seq, or 0 if empty.
  const recent = await fetchLogs(remote, cookie, 0)
  return recent.entries.length > 0 ? recent.entries[recent.entries.length - 1].seq : 0
}

async function fetchLogs(
  remote: RemoteManifest,
  cookie: string,
  since: number,
): Promise<ServerLogsResponse> {
  const res = await fetch(
    `${remote.public_url}/api/logs?since=${since}`,
    { headers: authHeaders(cookie), cache: "no-store" },
  )
  if (res.status === 401) throw new Error(`Unauthorized — re-run "jig debug login ${remote.handle}"`)
  if (!res.ok) throw new Error(`GET /api/logs → ${res.status}`)
  return (await res.json()) as ServerLogsResponse
}

async function getRunStatus(
  remote: RemoteManifest,
  cookie: string,
  runId: number,
): Promise<RunDetail> {
  const res = await fetch(
    `${remote.public_url}/api/runs/${runId}`,
    { headers: authHeaders(cookie), cache: "no-store" },
  )
  if (!res.ok) throw new Error(`GET /api/runs/${runId} → ${res.status}`)
  return (await res.json()) as RunDetail
}

async function postJson<T>(url: string, cookie: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: "POST",
    headers: { ...authHeaders(cookie), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(`${res.status} ${text || res.statusText}`)
  }
  return (await res.json()) as T
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

type Emit = (line: string) => void

/**
 * `--local` runs inside the container, where installLogCapture() has already
 * wrapped console.log to insert a row per call. Printing the dump through it
 * would write the logs back into the table it just read and evict the oldest
 * real entries against the retention cap. Write to the fd directly instead.
 */
const rawEmit: Emit = (line) => { process.stdout.write(`${line}\n`) }
const consoleEmit: Emit = (line) => { console.log(line) }

function printEntry(entry: ServerLogEntry, emit: Emit = consoleEmit): void {
  if (!isInterestingForDebug(entry)) return
  const ts = new Date(entry.ts).toISOString().slice(11, 23)
  const level = entry.level === "error" ? "ERR " : entry.level === "warn" ? "WARN" : "INFO"
  const tag = `[${ts}] ${level}`
  emit(`${tag}  ${entry.msg}`)
  if (entry.payload) {
    const pretty = formatPayload(entry.payload)
    for (const line of pretty) emit(`    │  ${line}`)
  }
}

function formatPayload(raw: string): string[] {
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return [raw] }
  const text = JSON.stringify(parsed, null, 2)
  const lines = text.split("\n")
  if (lines.length <= PAYLOAD_MAX_LINES) return lines
  const keep = Math.floor(PAYLOAD_MAX_LINES / 2)
  return [
    ...lines.slice(0, keep),
    `… (${lines.length - PAYLOAD_MAX_LINES} lines truncated; use the dashboard for the full payload)`,
    ...lines.slice(lines.length - keep),
  ]
}

/**
 * Mirror of the dashboard's isOperationalLog whitelist — keeps `jig debug`
 * output focused on debugging signal, not request-routing chatter.
 */
function isInterestingForDebug(entry: ServerLogEntry): boolean {
  const msg = entry.msg.trim()
  if (entry.level === "error" || entry.level === "warn") return true
  if (/^\[run\]\s/.test(msg)) return true
  if (/^\[runner\]\s/.test(msg)) return true
  if (/^\[sdk\.(llm|agent)\]\s/.test(msg)) return true
  if (/^\[mcp\.tool\]\s/.test(msg)) return true
  if (/^\[authoring\.(agent|discovery)\]\s/.test(msg)) return true
  if (/^\[repair\]\s/.test(msg)) return true
  if (/^\[scheduler\]\s/.test(msg)) return true
  if (/^\[connection\]\s/.test(msg)) return true
  if (/^\[composio\]\s/.test(msg)) return true
  if (/^\[webhook\]\s/.test(msg)) return true
  return false
}

// ---------------------------------------------------------------------------
// Misc helpers
// ---------------------------------------------------------------------------

function positional(args: string[]): string | undefined {
  return args.find((a) => !a.startsWith("--"))
}

function numericFlag(args: string[], name: string): number | undefined {
  const flag = args.find((a) => a.startsWith(`${name}=`))
  if (!flag) return undefined
  const value = parseInt(flag.slice(name.length + 1), 10)
  return Number.isFinite(value) ? Math.max(0, value) : undefined
}

function readPassword(args: string[]): string | undefined {
  const flag = args.find((a) => a.startsWith("--password="))
  if (flag) return flag.slice("--password=".length)
  return process.env.JIG_PASSWORD
}

function resolveRemoteOrExit(handle: string | undefined): RemoteManifest {
  try {
    if (handle) return resolveActiveRemote(handle)
    const remotes = listRemotes()
    if (remotes.length === 0) {
      console.error("No remotes configured. Run `jig deploy` first.")
      process.exit(1)
    }
    if (remotes.length === 1) return remotes[0]
    console.error(`Multiple remotes: ${remotes.map((r) => r.handle).join(", ")}. Pass one as the last arg.`)
    process.exit(1)
  } catch (e: any) {
    console.error(e.message)
    process.exit(1)
  }
}

function extractCookie(setCookie: string, name: string): string | null {
  for (const part of setCookie.split(/,\s*(?=[^;]+?=)/)) {
    const m = part.match(new RegExp(`(?:^|; )${name}=([^;]+)`))
    if (m) return m[1]
  }
  return null
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

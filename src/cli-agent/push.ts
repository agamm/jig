/**
 * The CLI side of "a coding agent wrote this jig itself".
 *
 * `jig edit <id> --file=` hands a file the agent wrote to the instance
 * (creating the jig when it does not exist); `jig pending` closes the loop
 * without a browser; `jig types` pulls the instance's connection types so the
 * agent can write against them. All three follow the authoring target rule
 * (deployed instance unless --local), and local and remote print the same
 * thing because local calls the same handler the HTTP route does.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { ConnectionTypesResponse, PendingState, WriteJigCodeResponse } from "../../shared/api.js"
import { isValidJigId } from "../domain/jig-id.js"
import { resolveAuthoringTarget, type AuthoringTarget } from "./target.js"

function flag(argv: string[], name: string): string | undefined {
  return argv.find((a) => a.startsWith(`${name}=`))?.slice(name.length + 1)
}

async function remoteJson<T>(target: AuthoringTarget, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${target.base}${path}`, {
    method,
    headers: { ...target.headers, ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    cache: "no-store",
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let detail = text
    try { detail = JSON.parse(text)?.error ?? text } catch {}
    throw new Error(`${method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`)
  }
  return (await res.json()) as T
}

/** Push a file as a jig's code. Returns the process exit code. */
export async function pushJigFile(jigId: string, argv: string[], localBase: string): Promise<number> {
  if (!isValidJigId(jigId)) {
    console.error(`"${jigId}" is not a valid jig id: lowercase letters, digits, dashes and underscores.`)
    return 1
  }
  const file = flag(argv, "--file")
  if (!file) {
    console.error(`Usage: jig edit ${jigId} --file=<path> [--message=<msg>] [--approve]`)
    return 1
  }
  let code: string
  try {
    code = readFileSync(file, "utf-8")
  } catch {
    console.error(`Cannot read ${file}`)
    return 1
  }
  if (!code.trim()) {
    console.error(`${file} is empty. Refusing to push a blank jig.`)
    return 1
  }

  const target = resolveAuthoringTarget(argv, localBase)
  const approve = argv.includes("--approve")
  const body = { code, message: flag(argv, "--message") ?? `Pushed from ${file}`, approve }

  let res: WriteJigCodeResponse
  if (target.remote) {
    res = await remoteJson<WriteJigCodeResponse>(target, "PUT", `/api/jigs/${encodeURIComponent(jigId)}/code`, body)
  } else {
    const { handleWriteJigCode } = await import("../server/handlers/versions.js")
    res = (await (await handleWriteJigCode(jigId, body)).json()) as WriteJigCodeResponse
  }

  const verb = res.created ? "created" : "updated"
  if (res.check.length > 0) {
    console.error(`✗ ${jigId} ${verb} on ${target.label} as pending v${res.pendingVersionId}, not approved: ${res.check.length} problem${res.check.length === 1 ? "" : "s"}`)
    for (const line of res.check) console.error(`    ${line}`)
    console.error(`  Fix the file and push again: jig edit ${jigId} --file=${file}${approve ? " --approve" : ""}`)
    return 1
  }
  if (res.activeVersionId != null) {
    console.log(`✓ ${jigId} ${verb} on ${target.label} and active (v${res.activeVersionId}). Check ok.`)
    return 0
  }
  console.log(`✓ ${jigId} ${verb} on ${target.label} as pending v${res.pendingVersionId}. Check ok.`)
  console.log(`  Approve: jig pending ${jigId} approve   (or push with --approve)`)
  return 0
}

/** `jig pending <id> [approve|discard]` against the authoring target. Returns the exit code. */
export async function pendingCommand(jigId: string, action: string | undefined, argv: string[], localBase: string): Promise<number> {
  const target = resolveAuthoringTarget(argv, localBase)
  const path = `/api/jigs/${encodeURIComponent(jigId)}/pending`

  let pending: PendingState | null
  if (target.remote) {
    pending = await remoteJson<PendingState | null>(target, "GET", path)
  } else {
    const { getPending } = await import("../services/jig-store.js")
    pending = getPending(jigId)
  }
  if (!pending) {
    console.log(`No pending changes for ${jigId} on ${target.label}.`)
    return 0
  }

  if (action === "approve") {
    if (target.remote) await remoteJson(target, "POST", `${path}/approve`)
    else (await import("../services/jig-store.js")).approvePending(jigId)
    console.log(`Approved pending changes for ${jigId} on ${target.label} (now active).`)
    return 0
  }
  if (action === "discard") {
    if (target.remote) await remoteJson(target, "DELETE", path)
    else (await import("../services/jig-store.js")).discardPending(jigId)
    console.log(`Discarded pending changes for ${jigId} on ${target.label}.`)
    return 0
  }
  console.log(`Pending changes for ${jigId} on ${target.label}: +${pending.addedLines} −${pending.removedLines} lines\n`)
  console.log(pending.diff)
  console.log(`\nRun 'jig pending ${jigId} approve' to apply, or 'jig pending ${jigId} discard' to drop.`)
  return 0
}

/**
 * `jig types [--out=<dir>]`: the instance's connection `.d.ts` files, written
 * to `.jig/connections/` by default because that is where the repo's tsconfig
 * resolves `@jig/connections/*`, so an editor and `tsc` in a clone paired to a
 * deployed instance see the same types the instance checks against.
 * Returns the exit code.
 */
export async function pullTypes(argv: string[], localBase: string): Promise<number> {
  const { CONNECTIONS_DIR, TYPES_DIR } = await import("../config/paths.js")
  const target = resolveAuthoringTarget(argv, localBase)
  const outDir = flag(argv, "--out") ?? CONNECTIONS_DIR

  let files: Record<string, string>
  if (target.remote) {
    files = (await remoteJson<ConnectionTypesResponse>(target, "GET", "/api/connections/types")).files
  } else {
    files = {}
    if (existsSync(TYPES_DIR)) {
      for (const name of readdirSync(TYPES_DIR).sort()) {
        if (name.endsWith(".d.ts")) files[name] = readFileSync(join(TYPES_DIR, name), "utf-8")
      }
    }
  }

  const names = Object.keys(files)
  if (names.length === 0) {
    console.log(`No connection types on ${target.label} yet. Connect a service first: jig connect <server>`)
    return 0
  }
  // A local instance already keeps these in CONNECTIONS_DIR; only copy elsewhere.
  if (target.remote || outDir !== CONNECTIONS_DIR) {
    mkdirSync(outDir, { recursive: true })
    for (const name of names) writeFileSync(join(outDir, name), files[name])
  }
  const servers = names.filter((n) => n !== "index.d.ts").map((n) => n.replace(/\.d\.ts$/, ""))
  console.log(`${names.length} type files from ${target.label} in ${outDir}: ${servers.join(", ")}`)
  console.log(`In a jig: import { ${servers[0] ?? "server"} } from "@jig/connections/${servers[0] ?? "server"}.js"`)
  return 0
}

/**
 * `jig backup` and `jig backup restore`.
 *
 * Follows the authoring target rule (cli-agent/target.ts): the instance you
 * deployed unless you say `--local`, `--handle=<name>` to choose. A deployed
 * instance is backed up over HTTP with the paired session (GET /api/backup,
 * POST /api/backup/restore, the same routes the dashboard uses); this machine
 * is backed up in-process, so no server has to be running for it.
 *
 * Thin glue only: argument parsing, file I/O and printing. All of the decisions
 * live in src/backup, and the remote path runs those same functions inside the
 * instance, so what the archive holds and what a restore touches cannot differ
 * by where you ran the command.
 *
 * The restore verb sits under `backup` because the top-level `jig restore`
 * already means "roll a jig back to an earlier version", which is a different
 * operation on a different noun.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import type { BackupRestorePlan, BackupRestoreResponse } from "../../shared/api.js"
import { buildArchive, parseArchive } from "../backup/archive.js"
import { applyRestore, collectSnapshot, planRestore } from "../backup/index.js"
import { resolveAuthoringTarget, type AuthoringTarget } from "../cli-agent/target.js"

function flag(args: string[], name: string): boolean {
  return args.includes(name)
}

function value(args: string[], name: string): string | undefined {
  const inline = args.find((a) => a.startsWith(`${name}=`))
  if (inline) return inline.slice(name.length + 1)
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

/** backup-2026-08-22.zip, with the time only when a name would otherwise collide. */
function defaultFileName(now: Date): string {
  const stamp = now.toISOString().slice(0, 10)
  const base = `jig-backup-${stamp}`
  if (!existsSync(`${base}.zip`)) return `${base}.zip`
  const time = now.toISOString().slice(11, 19).replace(/:/g, "")
  return `${base}-${time}.zip`
}

export async function runBackupArgs(args: string[], localBase: string): Promise<void> {
  if (args[0] === "restore") return runRestore(args.slice(1), localBase)
  if (flag(args, "--help") || flag(args, "-h")) return printUsage()
  return runBackup(args, localBase)
}

function printUsage(): void {
  console.log("Usage:")
  console.log("  jig backup [--out <file.zip>] [--no-credentials]")
  console.log("  jig backup restore <file.zip> [--dry-run] [--backup-password=<pw>]")
  console.log("")
  console.log("Acts on your deployed instance when you have one (--handle=<name> to choose),")
  console.log("or on this machine with --local.")
  console.log("")
  console.log("Backup contains your jigs, schedules, connections, tool permissions,")
  console.log("settings and jig memory. Credentials travel encrypted, exactly as stored.")
  console.log("A restore never changes the instance's password: credentials from a backup")
  console.log("made under another password are opened with that password and re-encrypted.")
  console.log("")
  console.log("  --no-credentials        Leave secrets out, for an archive you can share")
  console.log("  --dry-run               Print what a restore would change, then stop")
  console.log("  --backup-password=<pw>  The password the backup was made under (or JIG_BACKUP_PASSWORD;")
  console.log("                          a terminal asks for it when needed)")
}

/** Fetch against the deployed instance with the paired session; failures name the fix. */
async function remoteFetch(
  target: AuthoringTarget & { remote: true },
  method: string,
  path: string,
  body?: Uint8Array,
  extraHeaders: Record<string, string> = {},
): Promise<Response> {
  const res = await fetch(`${target.base}${path}`, {
    method,
    headers: { ...target.headers, ...(body ? { "Content-Type": "application/zip" } : {}), ...extraHeaders },
    body: body as unknown as BodyInit | undefined,
    cache: "no-store",
  })
  if (res.status === 401) throw new Error(`Unauthorized. Re-run "jig unlock ${target.manifest.handle}".`)
  if (res.status === 423) throw new Error(`${target.manifest.handle} is locked. Run "jig unlock ${target.manifest.handle}" first.`)
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    let detail = text
    try { detail = JSON.parse(text)?.error ?? text } catch {}
    throw new Error(`${method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`)
  }
  return res
}

async function runBackup(args: string[], localBase: string): Promise<void> {
  const includeCredentials = !flag(args, "--no-credentials")
  const out = resolve(value(args, "--out") ?? defaultFileName(new Date()))
  const target = resolveAuthoringTarget(args, localBase)
  console.log(`Backing up ${target.label}...`)

  let archive: Uint8Array
  if (target.remote) {
    const res = await remoteFetch(target, "GET", `/api/backup?credentials=${includeCredentials ? "1" : "0"}`)
    archive = new Uint8Array(await res.arrayBuffer())
  } else {
    const { version } = await import("../../package.json")
    archive = buildArchive(collectSnapshot(), {
      jigVersion: String(version),
      createdAt: new Date().toISOString(),
      includeCredentials,
    })
  }

  // Parsing what we are about to keep is the integrity check: a truncated
  // download would otherwise sit on disk until the day it is needed.
  const { snapshot } = parseArchive(archive)
  writeFileSync(out, archive, { mode: 0o600 })

  const kb = (archive.length / 1024).toFixed(1)
  console.log(`Wrote ${out} (${kb} KB)`)
  console.log(`  ${snapshot.jigs.length} jig(s), ${Object.keys(snapshot.schemas).length} connection schema(s), ${snapshot.memory.length} memory entr(ies)`)
  if (includeCredentials) {
    console.log(`  ${snapshot.credentials.length} credential(s), encrypted. Restoring them needs that instance's password.`)
  } else {
    console.log(`  No credentials. You will reconnect each server after restoring.`)
  }
}

function describe(plan: BackupRestorePlan): void {
  const { added, overwritten } = plan.jigs
  if (added.length) console.log(`  add ${added.length} jig(s): ${added.join(", ")}`)
  if (overwritten.length) console.log(`  overwrite ${overwritten.length} jig(s): ${overwritten.join(", ")}`)
  if (!added.length && !overwritten.length) console.log(`  no jigs in this backup`)
  console.log(`  ${plan.credentials} credential(s), ${plan.connections} custom server(s), ${plan.schemas} schema(s), ${plan.memory} memory entr(ies)`)
  for (const warning of plan.warnings) console.log(`\n  ! ${warning}`)
}

async function runRestore(args: string[], localBase: string): Promise<void> {
  const file = args.find((a) => !a.startsWith("--"))
  if (!file) {
    console.error("Usage: jig backup restore <file.zip> [--dry-run] [--force]")
    process.exit(1)
  }
  const path = resolve(file)
  if (!existsSync(path)) {
    console.error(`No such file: ${path}`)
    process.exit(1)
  }

  const bytes = new Uint8Array(readFileSync(path))
  let parsed: ReturnType<typeof parseArchive>
  try {
    parsed = parseArchive(bytes)
  } catch (error) {
    console.error(`Could not read ${path}: ${(error as Error).message}`)
    process.exit(1)
  }

  const dryRun = flag(args, "--dry-run")
  const target = resolveAuthoringTarget(args, localBase)
  console.log(`Backup from ${parsed.manifest.createdAt}, written by jig ${parsed.manifest.jigVersion}.`)
  console.log(`Restoring to ${target.label}...`)

  // Preview first, everywhere: it is what says whether the backup's password is
  // needed, and the only way to ask for it before anything is written.
  const preview = target.remote
    ? ((await (await remoteFetch(target, "POST", "/api/backup/restore?dryRun=1", bytes)).json()) as BackupRestoreResponse).plan
    : planRestore(parsed.snapshot)
  let backupPassword = value(args, "--backup-password") ?? process.env.JIG_BACKUP_PASSWORD
  if (!dryRun && !backupPassword && preview.warnings.some((w) => /password/i.test(w))) {
    const { promptHiddenPassword } = await import("../cli-remote/unlock.js")
    backupPassword = (await promptHiddenPassword("  Backup's password (Enter to skip its credentials)")) || undefined
  }

  let plan: BackupRestorePlan
  if (dryRun) {
    plan = preview
  } else if (target.remote) {
    const headers: Record<string, string> = backupPassword ? { "x-jig-backup-password": backupPassword } : {}
    const res = await remoteFetch(target, "POST", "/api/backup/restore?dryRun=0", bytes, headers)
    plan = ((await res.json()) as BackupRestoreResponse).plan
  } else {
    plan = applyRestore(parsed.snapshot, { backupPassword })
  }

  if (dryRun) {
    console.log("\nThis would:")
    describe(plan)
    console.log("\nNothing was changed. Re-run without --dry-run to apply.")
    return
  }

  console.log("\nRestored:")
  describe(plan)
  if (plan.credentialsSkipped) {
    console.log("\n  Credentials were NOT restored. Re-run with --backup-password=<the backup's password>, or reconnect each server.")
  }
  // The instance re-syncs its schedules itself; a local restore ran with no
  // server up, so the next start is what picks the jigs up.
  if (!target.remote) console.log("\nStart jig (or restart it) so the scheduler picks the jigs up.")
}

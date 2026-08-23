/**
 * `jig backup` and `jig backup restore`.
 *
 * Thin glue only: argument parsing, file I/O and printing. All of the decisions
 * live in src/backup, so the same logic can be driven from the dashboard later
 * without dragging console output along with it.
 *
 * The restore verb sits under `backup` because the top-level `jig restore`
 * already means "roll a jig back to an earlier version", which is a different
 * operation on a different noun.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { resolve } from "node:path"
import { buildArchive, parseArchive } from "../backup/archive.js"
import { applyRestore, collectSnapshot, planRestore, type RestorePlan } from "../backup/index.js"

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

export async function runBackupArgs(args: string[]): Promise<void> {
  if (args[0] === "restore") return runRestore(args.slice(1))
  if (flag(args, "--help") || flag(args, "-h")) return printUsage()
  return runBackup(args)
}

function printUsage(): void {
  console.log("Usage:")
  console.log("  jig backup [--out <file.zip>] [--no-credentials]")
  console.log("  jig backup restore <file.zip> [--dry-run] [--force]")
  console.log("")
  console.log("Backup contains your jigs, schedules, connections, tool permissions,")
  console.log("settings and jig memory. Credentials travel encrypted, exactly as stored,")
  console.log("so restoring them needs the same password this instance uses.")
  console.log("")
  console.log("  --no-credentials   Leave secrets out, for an archive you can share")
  console.log("  --dry-run          Print what a restore would change, then stop")
  console.log("  --force            Restore credentials even if the password differs")
}

async function runBackup(args: string[]): Promise<void> {
  const includeCredentials = !flag(args, "--no-credentials")
  const out = resolve(value(args, "--out") ?? defaultFileName(new Date()))

  const { version } = await import("../../package.json")
  const snapshot = collectSnapshot()
  const archive = buildArchive(snapshot, {
    jigVersion: String(version),
    createdAt: new Date().toISOString(),
    includeCredentials,
  })

  writeFileSync(out, archive, { mode: 0o600 })

  const kb = (archive.length / 1024).toFixed(1)
  console.log(`Wrote ${out} (${kb} KB)`)
  console.log(`  ${snapshot.jigs.length} jig(s), ${Object.keys(snapshot.schemas).length} connection schema(s), ${snapshot.memory.length} memory entr(ies)`)
  if (includeCredentials) {
    console.log(`  ${snapshot.credentials.length} credential(s), encrypted. Restoring them needs this instance's password.`)
  } else {
    console.log(`  No credentials. You will reconnect each server after restoring.`)
  }
}

function describe(plan: RestorePlan): void {
  const { added, overwritten } = plan.jigs
  if (added.length) console.log(`  add ${added.length} jig(s): ${added.join(", ")}`)
  if (overwritten.length) console.log(`  overwrite ${overwritten.length} jig(s): ${overwritten.join(", ")}`)
  if (!added.length && !overwritten.length) console.log(`  no jigs in this backup`)
  console.log(`  ${plan.credentials} credential(s), ${plan.connections} custom server(s), ${plan.schemas} schema(s), ${plan.memory} memory entr(ies)`)
  for (const warning of plan.warnings) console.log(`\n  ! ${warning}`)
}

async function runRestore(args: string[]): Promise<void> {
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

  let parsed: ReturnType<typeof parseArchive>
  try {
    parsed = parseArchive(new Uint8Array(readFileSync(path)))
  } catch (error) {
    console.error(`Could not read ${path}: ${(error as Error).message}`)
    process.exit(1)
  }

  const { manifest, snapshot } = parsed
  console.log(`Backup from ${manifest.createdAt}, written by jig ${manifest.jigVersion}.`)

  if (flag(args, "--dry-run")) {
    console.log("\nThis would:")
    describe(planRestore(snapshot))
    console.log("\nNothing was changed. Re-run without --dry-run to apply.")
    return
  }

  const result = applyRestore(snapshot, { force: flag(args, "--force") })
  console.log("\nRestored:")
  describe(result)
  if (result.credentialsSkipped) {
    console.log("\n  Credentials were NOT restored. Reconnect each server, or re-run with --force.")
  }
  console.log("\nStart jig (or restart it) so the scheduler picks the jigs up.")
}

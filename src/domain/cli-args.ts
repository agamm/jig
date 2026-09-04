/**
 * Top-level CLI argument split.
 *
 * `--dry-run` is applied to this process for local runs. It also survives in
 * `rest` for commands that must interpret it themselves, such as a remote run
 * or backup restore.
 */
export interface SplitCliArgs {
  dryRun: boolean
  command: string | undefined
  rest: string[]
}

/**
 * Commands that interpret `--dry-run` themselves, so the flag has to survive
 * into the subcommand instead of only flipping this process into dry-run mode.
 *
 * `run` may target a remote server and sends the flag in the request body.
 * `backup restore` uses it to mean "print the plan and change nothing",
 * which is a decision the restore code makes, not the SDK. Leaving either out
 * makes the flag silently do the real thing.
 */
const FORWARDS_DRY_RUN = new Set(["run", "backup"])

export function splitCliArgs(rawArgs: string[]): SplitCliArgs {
  const dryRun = rawArgs.includes("--dry-run")
  const [command, ...rest] = rawArgs.filter((a) => a !== "--dry-run")
  return {
    dryRun,
    command,
    rest: dryRun && command && FORWARDS_DRY_RUN.has(command) ? [...rest, "--dry-run"] : rest,
  }
}

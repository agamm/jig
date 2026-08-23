/**
 * Top-level CLI argument split.
 *
 * `--dry-run` is consumed here and applied to THIS process via setDryRun, which
 * is what a local `jig run` needs. `jig debug run` is different: the run happens
 * on a remote server, so the flag has to survive into the subcommand and be sent
 * in the request body. Stripping it for every command meant `jig debug run
 * --dry-run` silently performed a real run against production, including sending
 * real email — the exact opposite of what the flag promises.
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
 * `debug` runs the jig on a remote server and sends the flag in the request
 * body. `backup restore` uses it to mean "print the plan and change nothing",
 * which is a decision the restore code makes, not the SDK. Leaving either out
 * makes the flag silently do the real thing.
 */
const FORWARDS_DRY_RUN = new Set(["debug", "backup"])

export function splitCliArgs(rawArgs: string[]): SplitCliArgs {
  const dryRun = rawArgs.includes("--dry-run")
  const [command, ...rest] = rawArgs.filter((a) => a !== "--dry-run")
  return {
    dryRun,
    command,
    rest: dryRun && command && FORWARDS_DRY_RUN.has(command) ? [...rest, "--dry-run"] : rest,
  }
}

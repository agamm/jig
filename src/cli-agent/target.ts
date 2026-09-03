/**
 * Which instance should `jig new` / `jig edit` author against?
 *
 * The answer people expect is "the one I deployed", not "a local server you
 * started behind my back". `jig setup` already resolves targets this way, so
 * authoring follows the same rule: an active remote wins, local is the fallback
 * and `--local` is how you say you meant it.
 */
import { listRemotes, resolveActiveRemote } from "../cli-remote/manifest.js"

export interface AuthoringTarget {
  base: string
  headers: Record<string, string>
  /** For the "Authoring on X" line, so it is never a surprise where this landed. */
  label: string
  remote: boolean
}

export function parseTargetArgs(argv: string[]): { local: boolean; handle?: string } {
  return {
    local: argv.includes("--local"),
    handle: argv.find((a) => a.startsWith("--handle="))?.slice("--handle=".length),
  }
}

/**
 * Throws with an actionable message rather than silently falling back to local:
 * authoring on the wrong instance is the kind of mistake you only notice later.
 */
export function resolveAuthoringTarget(
  argv: string[],
  localBase: string,
): AuthoringTarget {
  const { local, handle } = parseTargetArgs(argv)
  if (local) return { base: localBase, headers: {}, label: "this machine", remote: false }
  if (listRemotes().length === 0) {
    return { base: localBase, headers: {}, label: "this machine", remote: false }
  }

  const remote = resolveActiveRemote(handle)
  if (!remote.session_cookie) {
    throw new Error(
      `No cached session for ${remote.handle}. Open its Setup page, press "Generate command" under Connect the CLI, and run the line it gives you.\n` +
        `  Or author locally instead with --local.`,
    )
  }
  return {
    base: remote.public_url,
    headers: { Cookie: `jig-admin=${remote.session_cookie}` },
    label: `${remote.handle} (${remote.public_url})`,
    remote: true,
  }
}

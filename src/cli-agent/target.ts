/**
 * Which instance should `jig new` / `jig edit` author against?
 *
 * The answer people expect is "the one I deployed", not "a local server you
 * started behind my back". `jig setup` already resolves targets this way, so
 * authoring follows the same rule: an active remote wins, local is the fallback
 * and `--local` is how you say you meant it.
 */
import { listRemotes, resolveActiveRemote, type RemoteManifest } from "../cli-remote/manifest.js"

interface AuthoringTargetBase {
  base: string
  headers: Record<string, string>
  /** For the "Authoring on X" line, so it is never a surprise where this landed. */
  label: string
}

export type AuthoringTarget =
  | AuthoringTargetBase & { remote: false }
  | AuthoringTargetBase & { remote: true; manifest: RemoteManifest }

function parseTargetArgs(argv: string[]): { local: boolean; handle?: string } {
  const handleFlag = argv.find((a) => a.startsWith("--handle="))
  const handle = handleFlag?.slice("--handle=".length)
  if (handleFlag && !handle) throw new Error("--handle requires a remote name.")
  return {
    local: argv.includes("--local"),
    handle,
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
  if (local && handle) throw new Error("Choose one target: --local or --handle=<name>.")
  if (local) return { base: localBase, headers: {}, label: "this machine", remote: false }
  if (listRemotes().length === 0) {
    if (handle) throw new Error("No remotes configured. Run `jig deploy` first, or omit --handle to use this machine.")
    return { base: localBase, headers: {}, label: "this machine", remote: false }
  }

  const remote = resolveActiveRemote(handle)
  if (!remote.session_cookie) {
    throw new Error(
      `No cached session for ${remote.handle}. Run \`jig unlock ${remote.handle}\` (instance password), or paste the pairing command from its Setup page.\n` +
        `  Or author locally instead with --local.`,
    )
  }
  return {
    base: remote.public_url,
    headers: { Cookie: `jig-admin=${remote.session_cookie}` },
    label: `${remote.handle} (${remote.public_url})`,
    remote: true,
    manifest: remote,
  }
}

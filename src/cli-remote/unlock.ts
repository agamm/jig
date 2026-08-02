/**
 * `jig unlock` — restore a deployed instance's crypto key from the terminal.
 *
 * Every restart re-locks the instance: the key is derived from the password
 * and held only in memory, so a deploy, crash or host migration leaves the
 * scheduler paused until someone unlocks. POST /api/unlock is what actually
 * restores it — the session cookie it returns is a side effect, and is no use
 * on a locked box because the lock gate runs before the cookie check.
 *
 * Reads the password from a hidden prompt so it stays out of shell history and
 * the process list. `--password=` and JIG_PASSWORD still work for scripts.
 */
import { setSessionCookie, type RemoteManifest } from "./manifest.js"
import type { HealthResponse } from "../../shared/api.js"

const COOKIE_NAME = "jig-admin"

export interface RemoteLockState {
  locked: boolean
  version?: string
  reachable: boolean
}

export async function fetchLockState(publicUrl: string): Promise<RemoteLockState> {
  try {
    const res = await fetch(`${publicUrl}/api/health`, { cache: "no-store" })
    if (!res.ok) return { locked: false, reachable: false }
    const body = (await res.json()) as HealthResponse
    return { locked: body.locked === true, version: body.version, reachable: true }
  } catch {
    return { locked: false, reachable: false }
  }
}

/**
 * Read a password without echoing it. Returns null when stdin isn't a TTY —
 * callers must treat that as "can't ask here" and print instructions instead
 * of blocking, or an automated deploy would hang forever waiting on input.
 */
export async function promptHiddenPassword(label = "Instance password"): Promise<string | null> {
  const stdin = process.stdin
  if (!stdin.isTTY || typeof stdin.setRawMode !== "function") return null

  process.stdout.write(`${label}: `)
  stdin.setRawMode(true)
  stdin.resume()
  stdin.setEncoding("utf8")

  return await new Promise<string | null>((resolve) => {
    let value = ""
    const done = (result: string | null) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener("data", onData)
      process.stdout.write("\n")
      resolve(result)
    }
    const onData = (chunk: string) => {
      for (const char of chunk) {
        switch (char) {
          case "\r":
          case "\n":
            return done(value)
          case "\u0003": // Ctrl-C
            return done(null)
          case "\u007f": // Backspace
          case "\b":
            value = value.slice(0, -1)
            break
          default:
            // Ignore other control characters rather than embedding them.
            if (char >= " ") value += char
        }
      }
    }
    stdin.on("data", onData)
  })
}

/** POST the password. Returns the session cookie on success. */
export async function unlockRemote(publicUrl: string, password: string): Promise<string | null> {
  const res = await fetch(`${publicUrl}/api/unlock`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`Unlock failed: ${res.status} ${body.slice(0, 200)}`)
  }
  const setCookie = res.headers.get("set-cookie") ?? ""
  const match = setCookie.match(new RegExp(`${COOKIE_NAME}=([^;]+)`))
  return match?.[1] ?? null
}

/**
 * Unlock a remote, prompting if needed. Returns true when the instance ends up
 * unlocked. Safe to call from a deploy: never blocks on a non-TTY, and treats
 * an already-unlocked instance as success.
 */
export async function ensureUnlocked(
  remote: RemoteManifest,
  opts?: { password?: string },
): Promise<boolean> {
  const state = await fetchLockState(remote.public_url)
  if (!state.reachable) {
    console.error(`  Couldn't reach ${remote.public_url}/api/health — unlock skipped.`)
    return false
  }
  if (!state.locked) return true

  const password = opts?.password ?? process.env.JIG_PASSWORD ?? (await promptHiddenPassword())
  if (!password) {
    console.log("")
    console.log(`  ${remote.handle} is locked — scheduled jigs stay paused until it's unlocked.`)
    console.log(`  Run: jig unlock ${remote.handle}`)
    return false
  }

  const cookie = await unlockRemote(remote.public_url, password)
  if (cookie) setSessionCookie(remote.handle, cookie)

  const after = await fetchLockState(remote.public_url)
  if (after.locked) {
    console.error(`  Still locked after unlock — check the password and retry.`)
    return false
  }
  console.log(`  ✓ ${remote.handle} unlocked — scheduler resumes on the next tick.`)
  return true
}

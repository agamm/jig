/**
 * `jig update` — advance a deployed jig instance to the latest git tag.
 *
 * v1 flow (Railway only, uses the `railway` CLI — no API tokens):
 *   1. Resolve remote manifest.
 *   2. `git fetch --tags origin`.
 *   3. Pick highest semver tag locally.
 *   4. Compare against /api/health on the remote; exit if current.
 *   5. Record current HEAD commit for rollback.
 *   6. Stash any dirty working tree changes.
 *   7. `git checkout <tag>` and `railway up` (synchronous, waits for deploy).
 *   8. Poll /api/health until version matches target.
 *   9. Restore stash; done.
 *  10. On failure: `git checkout <previous commit>` + `railway up` +
 *      restore stash.
 */
import { resolveActiveRemote } from "./manifest.js"
import { railwayInteractive } from "../cli-deploy/railway-cli.js"

interface HealthResponse {
  version: string
  locked: boolean
}

async function runText(cmd: string[], cwd = process.cwd()): Promise<string> {
  const proc = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`${cmd.join(" ")} failed (${code}): ${stderr.trim() || stdout.trim()}`)
  }
  return stdout
}

function parseSemverTag(tag: string): [number, number, number] | null {
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

async function getLatestRemoteTag(): Promise<{ tag: string; sha: string } | null> {
  await runText(["git", "fetch", "--tags", "--quiet", "origin"])
  const tagsRaw = await runText(["git", "tag", "--list"])
  const tags = tagsRaw
    .split("\n")
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => parseSemverTag(t))
    .sort((a, b) => compareSemver(parseSemverTag(b)!, parseSemverTag(a)!))
  if (tags.length === 0) return null
  const tag = tags[0]
  const sha = (await runText(["git", "rev-parse", `${tag}^{commit}`])).trim()
  return { tag, sha }
}

async function fetchHealth(publicUrl: string): Promise<HealthResponse> {
  const res = await fetch(`${publicUrl}/api/health`, { cache: "no-store" })
  if (!res.ok) throw new Error(`Health check ${res.status} at ${publicUrl}`)
  return (await res.json()) as HealthResponse
}

async function waitForVersion(publicUrl: string, expected: string[], timeoutMs = 5 * 60_000): Promise<string | null> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const h = await fetchHealth(publicUrl)
      if (expected.includes(h.version)) return h.version
    } catch {}
    await new Promise((r) => setTimeout(r, 5000))
  }
  return null
}

async function currentHeadCommit(): Promise<string> {
  return (await runText(["git", "rev-parse", "HEAD"])).trim()
}

async function gitClean(): Promise<boolean> {
  const status = await runText(["git", "status", "--porcelain"])
  return status.trim() === ""
}

async function gitStash(): Promise<string | null> {
  if (await gitClean()) return null
  const label = `jig-update-${Date.now()}`
  await runText(["git", "stash", "push", "--include-untracked", "--message", label])
  const list = await runText(["git", "stash", "list", "--format=%gd%x00%s"])
  const ref = list
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("\0"))
    .find(([, msg]) => msg === label)?.[0]
  return ref ?? null
}

async function gitStashPop(ref: string | null): Promise<void> {
  if (!ref) return
  await runText(["git", "stash", "pop", ref]).catch((e) => {
    console.warn(`  Warning: couldn't re-apply stash ${ref}. Resolve with: git stash pop ${ref}`)
    console.warn(`  ${e}`)
  })
}

async function railwayDeploy(): Promise<boolean> {
  // `--ci` streams build logs and exits when the build terminates. Gives the
  // user live progress AND a reliable exit code (non-zero on build failure).
  const code = await railwayInteractive(["up", "--ci"])
  return code === 0
}

export async function runUpdate(handle?: string): Promise<void> {
  const remote = resolveActiveRemote(handle)
  if (remote.target !== "railway") {
    throw new Error(`Unsupported target: ${remote.target}`)
  }
  console.log(`Updating ${remote.handle} (${remote.target}) — ${remote.public_url}`)

  const latest = await getLatestRemoteTag()
  if (!latest) {
    console.log("No semver tags found on origin. Tag a release (e.g. v0.2.0) and retry.")
    return
  }

  const current = await fetchHealth(remote.public_url).catch((e) => {
    console.error(`Cannot reach ${remote.public_url}: ${e}`)
    process.exit(1)
  })
  if (current.locked) {
    console.error("Remote is locked. Unlock it in the dashboard before running updates.")
    process.exit(1)
  }
  console.log(`  Current: ${current.version}`)
  console.log(`  Latest:  ${latest.tag} (${latest.sha.slice(0, 7)})`)

  if (current.version === latest.tag || `v${current.version}` === latest.tag) {
    console.log("Already current.")
    return
  }

  const rollbackCommit = await currentHeadCommit()
  const stashRef = await gitStash()

  let reverted = false
  try {
    console.log(`  Checking out ${latest.tag}...`)
    await runText(["git", "checkout", latest.tag])

    console.log(`  Uploading to Railway...`)
    const deployed = await railwayDeploy()
    if (!deployed) throw new Error("railway up failed")

    console.log(`  Waiting for ${remote.public_url}/api/health to report ${latest.tag}...`)
    const expected = [latest.tag, latest.tag.replace(/^v/, "")]
    const seen = await waitForVersion(remote.public_url, expected)
    if (!seen) throw new Error(`Health didn't report ${latest.tag} in time`)

    console.log(`\n  ✓ Updated to ${latest.tag}.`)

    // A restart re-locks the instance and the scheduler stays paused until
    // someone unlocks — ask now, while the operator is still watching.
    const { ensureUnlocked } = await import("./unlock.js")
    await ensureUnlocked(remote)
  } catch (e: any) {
    console.error(`  Deploy failed: ${e?.message ?? e}`)
    console.error(`  Rolling back to ${rollbackCommit.slice(0, 7)}...`)
    try {
      await runText(["git", "checkout", rollbackCommit])
      const rolledBack = await railwayDeploy()
      if (!rolledBack) throw new Error("rollback railway up failed")
      const expected = [current.version, `v${current.version}`]
      const seen = await waitForVersion(remote.public_url, expected, 5 * 60_000)
      if (!seen) throw new Error("Health didn't return to previous version in time")
      console.error("  Rollback complete.")
      reverted = true
    } catch (rollbackErr: any) {
      console.error(`  Rollback also failed: ${rollbackErr?.message ?? rollbackErr}`)
      console.error("  Investigate with: railway logs")
    }
    process.exitCode = 1
  } finally {
    if (!reverted && rollbackCommit) {
      // We left the working tree on the new tag on success; stash pop may
      // conflict with new source. That's preferable to losing changes.
    }
    await gitStashPop(stashRef)
  }
}

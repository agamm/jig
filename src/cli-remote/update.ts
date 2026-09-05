/**
 * `jig update` — advance a deployed jig instance to the latest git tag.
 *
 * v1 flow (Railway only, uses the `railway` CLI — no API tokens):
 *   1. Resolve remote manifest.
 *   2. `git fetch --tags origin`.
 *   3. Pick highest semver tag locally.
 *   4. Compare against /api/health on the remote; exit if current.
 *   5. Resolve the running version's exact tag for rollback.
 *   6. Remember the local checkout and stash any dirty working tree changes.
 *   7. `git checkout <tag>` and `railway up` (synchronous, waits for deploy).
 *   8. Poll /api/health until version matches target.
 *   9. Restore the original checkout and stash; done.
 *  10. On failure: deploy the running version's tag, then restore the local
 *      checkout and stash.
 */
import { resolveActiveRemote, type RemoteManifest } from "./manifest.js"
import { railwayInteractive } from "../cli-deploy/railway-cli.js"
import { PROJECT_ROOT } from "../config/paths.js"

interface HealthResponse {
  version: string
  locked: boolean
}

async function runText(cmd: string[], cwd = PROJECT_ROOT): Promise<string> {
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

export function releaseTagCandidates(version: string): string[] {
  const bare = version.replace(/^v/, "")
  if (!parseSemverTag(bare)) return []
  return [`v${bare}`, bare]
}

export function parseSemverTag(tag: string): [number, number, number] | null {
  const m = tag.match(/^v?(\d+)\.(\d+)\.(\d+)$/)
  if (!m) return null
  return [parseInt(m[1], 10), parseInt(m[2], 10), parseInt(m[3], 10)]
}

export function compareSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i]
  return 0
}

async function getLatestRemoteTag(): Promise<{ tag: string; sha: string } | null> {
  await runText(["git", "fetch", "--tags", "--quiet", "origin"])
  // `git tag --list` also includes unpushed local tags. Only origin tags are
  // release inputs; otherwise a stray local tag could become production code.
  const tagsRaw = await runText(["git", "ls-remote", "--tags", "--refs", "origin"])
  const tags = tagsRaw
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[1]?.replace(/^refs\/tags\//, ""))
    .filter(Boolean)
    .filter((t) => parseSemverTag(t))
    .sort((a, b) => compareSemver(parseSemverTag(b)!, parseSemverTag(a)!))
  if (tags.length === 0) return null
  const tag = tags[0]
  const sha = (await runText(["git", "rev-parse", `refs/tags/${tag}^{commit}`])).trim()
  return { tag, sha }
}

async function getReleaseTag(version: string): Promise<{ tag: string; sha: string } | null> {
  const candidates = releaseTagCandidates(version)
  if (candidates.length === 0) return null
  const raw = await runText([
    "git", "ls-remote", "--tags", "--refs", "origin",
    ...candidates.map((tag) => `refs/tags/${tag}`),
  ])
  const remoteTags = new Set(
    raw.split("\n")
      .map((line) => line.trim().split(/\s+/)[1]?.replace(/^refs\/tags\//, ""))
      .filter(Boolean),
  )
  for (const tag of candidates) {
    if (!remoteTags.has(tag)) continue
    try {
      const sha = (await runText(["git", "rev-parse", `refs/tags/${tag}^{commit}`])).trim()
      if (sha) return { tag, sha }
    } catch {
      // Repositories may consistently use either v-prefixed or bare tags.
    }
  }
  return null
}

/**
 * Should this instance move to that tag?
 *
 * Pure, because the answer is the whole safety property and the rest of this
 * file is git and network. The bug it exists to prevent: the check used to be
 * string equality, so an instance running a version NEWER than the newest tag
 * (tags lag main) failed the equality test and was checked out backwards onto
 * the old tag. That is a live downgrade past migrations that have already run
 * against the volume, which is not an update failure, it is data damage.
 */
export function decideUpdate(
  currentVersion: string,
  latestTag: string,
): { action: "update" | "current" | "ahead"; messages: string[] } {
  const running = parseSemverTag(currentVersion)
  const target = parseSemverTag(latestTag)

  if (running && target) {
    const delta = compareSemver(target, running)
    if (delta === 0) return { action: "current", messages: ["Already current."] }
    if (delta < 0) {
      return {
        action: "ahead",
        messages: [
          `This instance runs ${currentVersion}, which is newer than the latest tag ${latestTag}. Refusing to move it backwards.`,
          "Tag the release you want on origin (e.g. `git tag v0.2.0 && git push origin v0.2.0`), then re-run.",
        ],
      }
    }
    return { action: "update", messages: [] }
  }

  // One side is not a semver. Only an exact match is safe to call current;
  // anything else gets no direction guess.
  if (currentVersion === latestTag || `v${currentVersion}` === latestTag) {
    return { action: "current", messages: ["Already current."] }
  }
  return {
    action: "ahead",
    messages: [
      `Cannot compare the running version (${currentVersion}) with the latest tag (${latestTag}).`,
      "Refusing to deploy blind. Check both, then deploy the tag directly if it really is newer.",
    ],
  }
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

async function currentCheckout(): Promise<{ restoreRef: string; label: string }> {
  const commit = await currentHeadCommit()
  const branch = (await runText(["git", "symbolic-ref", "--quiet", "--short", "HEAD"]).catch(() => "")).trim()
  return branch
    ? { restoreRef: branch, label: branch }
    : { restoreRef: commit, label: commit.slice(0, 7) }
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
    // "On <branch>: <label>", not the bare label. See the same fix in cli.ts.
    .find(([, msg]) => msg.includes(label))?.[0]
  if (!ref) {
    throw new Error("Local changes were stashed, but the updater could not identify the stash to restore. They remain safe in `git stash list`.")
  }
  return ref
}

async function gitStashPop(ref: string | null): Promise<void> {
  if (!ref) return
  try {
    await runText(["git", "stash", "apply", "--index", ref])
    await runText(["git", "stash", "drop", ref])
  } catch (e) {
    console.warn(`  Warning: couldn't re-apply stash ${ref}. Resolve with: git stash pop ${ref}`)
    console.warn(`  ${e}`)
  }
}

async function railwayDeploy(): Promise<boolean> {
  // `--ci` streams build logs and exits when the build terminates. Gives the
  // user live progress AND a reliable exit code (non-zero on build failure).
  const code = await railwayInteractive(["up", "--ci"], PROJECT_ROOT)
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

  const decision = decideUpdate(current.version, latest.tag)
  if (decision.action !== "update") {
    for (const line of decision.messages) console.log(line)
    return
  }

  // A rollback must redeploy the source that produced the running version,
  // never whichever unrelated commit happens to be checked out locally.
  const rollback = await getReleaseTag(current.version)
  if (!rollback) {
    throw new Error(
      `Cannot prove a rollback source for the running version ${current.version}. ` +
      `Expected one of these tags on origin: ${releaseTagCandidates(current.version).join(", ") || "a semver release tag"}.`,
    )
  }

  if (remote.image && remote.railway?.service_id && remote.railway.environment_id) {
    await updateImageInstance(remote, latest.tag, rollback.tag)
    return
  }

  const originalCheckout = await currentCheckout()
  const stashRef = await gitStash()

  let deployedTarget = false
  try {
    console.log(`  Checking out ${latest.tag}...`)
    await runText(["git", "checkout", latest.tag])

    console.log(`  Uploading to Railway...`)
    const deployed = await railwayDeploy()
    if (!deployed) throw new Error("railway up failed")

    console.log(`  Waiting for ${remote.public_url}/api/health to report ${latest.tag}...`)
    const expected = releaseTagCandidates(latest.tag)
    const seen = await waitForVersion(remote.public_url, expected)
    if (!seen) throw new Error(`Health didn't report ${latest.tag} in time`)

    deployedTarget = true
    console.log(`\n  ✓ Updated to ${latest.tag}.`)
  } catch (e: any) {
    console.error(`  Deploy failed: ${e?.message ?? e}`)
    console.error(`  Rolling back to ${rollback.tag} (${rollback.sha.slice(0, 7)})...`)
    try {
      await runText(["git", "checkout", rollback.tag])
      const rolledBack = await railwayDeploy()
      if (!rolledBack) throw new Error("rollback railway up failed")
      const expected = releaseTagCandidates(current.version)
      const seen = await waitForVersion(remote.public_url, expected, 5 * 60_000)
      if (!seen) throw new Error("Health didn't return to previous version in time")
      console.error("  Rollback complete.")
    } catch (rollbackErr: any) {
      console.error(`  Rollback also failed: ${rollbackErr?.message ?? rollbackErr}`)
      console.error("  Investigate with: railway logs")
    }
    process.exitCode = 1
  } finally {
    try {
      await runText(["git", "checkout", originalCheckout.restoreRef])
      await gitStashPop(stashRef)
    } catch (restoreErr) {
      console.warn(`  Warning: couldn't restore the original checkout ${originalCheckout.label}.`)
      if (stashRef) console.warn(`  Local changes remain safe in ${stashRef}; restore them after checking out ${originalCheckout.label}.`)
      console.warn(`  ${restoreErr}`)
    }
  }

  // Unlocking is post-deploy recovery, not part of the deploy transaction. A
  // missing or mistyped password must never roll a healthy new release back.
  if (deployedTarget) {
    const { ensureUnlocked } = await import("./unlock.js")
    await ensureUnlocked(remote)
  }
}

/**
 * Image-based instances (created by `jig deploy` from the published image) do
 * not build anything: point the service at the release image, deploy, wait for
 * the version, and on failure point it back at the image that was running.
 */
async function updateImageInstance(remote: RemoteManifest, latestTag: string, rollbackTag: string): Promise<void> {
  const { imageRef, ghcrTagExists } = await import("../cli-deploy/image.js")
  const { setServiceImage } = await import("../cli-deploy/railway-cli.js")
  const { saveRemote } = await import("./manifest.js")
  const ids = { serviceId: remote.railway!.service_id, environmentId: remote.railway!.environment_id }

  if (!(await ghcrTagExists(latestTag))) {
    console.error(`  The image for ${latestTag} is not published yet (ghcr.io). The publish workflow runs on every tag push; retry in a few minutes.`)
    process.exitCode = 1
    return
  }
  const target = imageRef(latestTag)
  const previous = remote.image ?? imageRef(rollbackTag)

  let deployedTarget = false
  try {
    console.log(`  Switching the service to ${target}...`)
    await setServiceImage({ ...ids, image: target })
    console.log(`  Waiting for ${remote.public_url}/api/health to report ${latestTag}...`)
    const seen = await waitForVersion(remote.public_url, releaseTagCandidates(latestTag))
    if (!seen) throw new Error(`Health didn't report ${latestTag} in time`)
    saveRemote({ ...remote, image: target })
    deployedTarget = true
    console.log(`\n  ✓ Updated to ${latestTag}.`)
  } catch (e: any) {
    console.error(`  Deploy failed: ${e?.message ?? e}`)
    console.error(`  Rolling back to ${previous}...`)
    try {
      await setServiceImage({ ...ids, image: previous })
      const seen = await waitForVersion(remote.public_url, releaseTagCandidates(rollbackTag), 5 * 60_000)
      if (!seen) throw new Error("Health didn't return to the previous version in time")
      console.error("  Rollback complete.")
    } catch (rollbackErr: any) {
      console.error(`  Rollback also failed: ${rollbackErr?.message ?? rollbackErr}`)
      console.error("  Investigate with: railway logs")
    }
    process.exitCode = 1
  }

  if (deployedTarget) {
    const { ensureUnlocked } = await import("./unlock.js")
    await ensureUnlocked(remote)
  }
}

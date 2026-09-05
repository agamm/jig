/**
 * `jig deploy` — interactive wizard that provisions a Railway instance.
 *
 * Zero required env vars. The user picks a project name and we wrap the
 * `railway` CLI end-to-end. Auth comes from `railway login`.
 *
 * Flow:
 *   1. Detect `railway` binary; offer `bun install -g @railway/cli`.
 *   2. `railway login` (opens browser) if not already logged in; confirm the account.
 *   3. Pick a project slug (defaults to a random one).
 *   4. `railway init --name <slug> [-w <workspace>]`, then create the service
 *      from the published image with the setup code and timezone as variables.
 *   5. Mount a volume at /data (GraphQL, no prompt).
 *   6. Generate a public domain and wait for /api/health.
 *   7. Save manifest at ~/.config/jig/remotes/<slug>.json, setup code included.
 *
 * Nothing is built here: the image comes from ghcr.io (see image.ts), so a
 * deploy is pull plus boot. With `--yes`, or without a terminal, every prompt
 * takes its default and destructive confirmations answer no, so a coding
 * agent can run it end to end.
 *
 * Post-wizard: the user opens the URL, enters the setup code, chooses a
 * password; `jig setup <handle>` then pairs itself and continues.
 */
import { createInterface } from "node:readline/promises"
import { readFileSync } from "node:fs"
import { deleteRemote, getRemote, saveRemote, type RemoteManifest } from "../cli-remote/manifest.js"
import {
  addImageService,
  createServiceDomain,
  createVolume,
  deleteProject,
  findProjectsByName,
  getPublicUrl,
  getRailwayIdentity,
  getStatus,
  hasVolumeAtPath,
  installRailway,
  isLoggedIn,
  isRailwayInstalled,
  linkService,
  listProjects,
  listVolumes,
  railwayInteractive,
  setServiceImage,
  setServiceVariables,
  type RailwayStatus,
} from "./railway-cli.js"
import { detectRuntimeTimeZone, writeDeployDefaults } from "../config/timezone.js"
import { mintSetupCode } from "../auth/setup-code.js"
import { resolveDeployImage } from "./image.js"
import { PROJECT_ROOT } from "../config/paths.js"

export interface DeployOptions {
  /** Take every default and skip confirmations; destructive ones answer no. */
  yes?: boolean
  /** Railway workspace ID or name for `railway init -w`. */
  workspace?: string
}

// Set per run by runDeploy. Without a terminal there is nobody to ask, so
// prompts take defaults instead of hanging on stdin.
let assumeYes = false
const hasTerminal = () => Boolean(process.stdin.isTTY && process.stdout.isTTY)
const nonInteractive = () => assumeYes || !hasTerminal()

async function prompt(question: string, defaultValue?: string): Promise<string> {
  if (nonInteractive()) {
    if (defaultValue === undefined) throw new Error(`"${question}" needs a terminal to answer and has no default.`)
    console.log(`${question}: ${defaultValue}`)
    return defaultValue
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const suffix = defaultValue ? ` [${defaultValue}]` : ""
  const answer = (await rl.question(`${question}${suffix}: `)).trim()
  rl.close()
  return answer || (defaultValue ?? "")
}

/**
 * `destructive` confirmations (deleting projects, replacing a manifest) never
 * auto-accept: with --yes or no terminal they answer no and the caller stops
 * with instructions. Everything else follows --yes, or its default when there
 * is simply no terminal.
 */
async function confirm(question: string, defaultYes = true, opts: { destructive?: boolean } = {}): Promise<boolean> {
  if (assumeYes) return !opts.destructive
  if (!hasTerminal()) {
    console.log(`${question} (no terminal; taking ${opts.destructive ? "no" : defaultYes ? "yes" : "no"})`)
    return opts.destructive ? false : defaultYes
  }
  const suffix = defaultYes ? " [Y/n]" : " [y/N]"
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ans = (await rl.question(`${question}${suffix} `)).trim()
  rl.close()
  if (!ans) return defaultYes
  return ans.toLowerCase().startsWith("y")
}

/** Volume at /data by API first; the CLI's prompt-driven command only as a fallback at a terminal. */
async function attachDataVolume(status: RailwayStatus | null): Promise<void> {
  if (status) {
    try {
      await createVolume({ projectId: status.projectId, environmentId: status.environmentId, serviceId: status.serviceId, mountPath: "/data" })
      return
    } catch (error) {
      console.log(`  (volume via API failed: ${(error as Error)?.message ?? error}; trying the CLI)`)
    }
  }
  if (!hasTerminal()) throw new Error("Could not create the /data volume without a terminal.")
  console.log("  Enter any name when prompted.")
  const volArgs = status
    ? ["volume", "-s", status.serviceId, "-e", status.environmentId, "add", "--mount-path", "/data"]
    : ["volume", "add", "--mount-path", "/data"]
  const code = await railwayInteractive(volArgs)
  if (code !== 0) console.log("  (volume attach reported non-zero; verifying...)")
}

async function ensureRailwayLogin(): Promise<void> {
  if (await isLoggedIn()) return

  console.log("Opening Railway login in your browser...")
  const code = await railwayInteractive(["login"])
  if (code !== 0 || !(await isLoggedIn())) {
    console.error("railway login failed. Re-run `jig deploy` once you're logged in.")
    process.exit(1)
  }
}

async function fetchHealth(publicUrl: string): Promise<{ ok: boolean; status?: number }> {
  try {
    const res = await fetch(`${publicUrl}/api/health`, { cache: "no-store" })
    return { ok: res.ok, status: res.status }
  } catch {
    return { ok: false }
  }
}

async function waitForFirstHealth(publicUrl: string, timeoutMs = 5 * 60_000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const { ok } = await fetchHealth(publicUrl)
    if (ok) return true
    await new Promise((r) => setTimeout(r, 5000))
  }
  return false
}

function slugify(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "jig"
}

export async function runDeployArgs(args: string[]): Promise<void> {
  if (args.includes("--attach-volume")) {
    await runAttachVolume()
    return
  }
  if (args.includes("--update")) {
    await runUpdateInPlace()
    return
  }
  const target = args.find((a) => !a.startsWith("--"))
  await runDeploy(target, {
    yes: args.includes("--yes") || args.includes("-y"),
    workspace: args.find((a) => a.startsWith("--workspace="))?.slice("--workspace=".length),
  })
}

/**
 * Recovery: attach the `/data` persistent volume to an already-linked Railway
 * project that's missing one. Running without this, every redeploy wipes
 * SQLite (password, OAuth tokens, jigs — everything) because `/data` is
 * ephemeral container filesystem without a volume mounted there.
 *
 * Data already written to the ephemeral filesystem is lost the moment the
 * volume attaches, since the mount shadows the old directory. We still
 * surface the sequence so the user knows what to expect.
 */
async function runAttachVolume(): Promise<void> {
  console.log("jig deploy --attach-volume — attach missing /data volume to the linked Railway project.\n")
  if (!(await isRailwayInstalled())) {
    console.error("Railway CLI not found. Run `jig deploy` first to provision an instance.")
    process.exit(1)
  }
  await ensureRailwayLogin()
  const status = await getStatus()
  if (!status) {
    console.error("This directory isn't linked to a Railway project. Run `railway link` or `jig deploy` first.")
    process.exit(1)
  }
  try {
    if (await hasVolumeAtPath("/data")) {
      console.log(`  ✓ ${status.projectName} already has a volume at /data. Nothing to do.`)
      return
    }
  } catch (error) {
    console.error(`\nCould not check existing volumes: ${(error as Error)?.message ?? error}`)
    console.error("Not attaching blind: a second mount at /data would shadow the current one.")
    process.exit(1)
  }
  console.log(`  Linked to: ${status.projectName} / ${status.serviceId.slice(0, 8)}`)
  console.log("  No volume at /data — attaching now.\n")
  console.log("Attaching /data volume...")
  try {
    await attachDataVolume(status)
  } catch (error) {
    console.error(`\n${(error as Error)?.message ?? error}`)
    process.exit(1)
  }
  if (!(await hasVolumeAtPath("/data").catch(() => false))) {
    console.error("\nVolume still missing after attach. Check the Railway dashboard and retry.")
    process.exit(1)
  }
  console.log("\n  ✓ Volume attached. Redeploy now: `jig deploy --update`")
  console.log("  Note: any data written to /data before the volume was attached is gone — you'll need to re-onboard once.")
}

/**
 * Re-upload the current working directory to the already-linked Railway
 * project. Faster than the full wizard — no project creation, no volume
 * attach, no domain generation. Used for dev iteration: `jig deploy --update`.
 */
async function runUpdateInPlace(): Promise<void> {
  console.log("jig deploy --update — redeploy current code to the linked Railway project.\n")

  if (!(await isRailwayInstalled())) {
    console.error("Railway CLI not found. Run `jig deploy` without --update first to provision an instance.")
    process.exit(1)
  }
  await ensureRailwayLogin()

  const status = await getStatus()
  if (!status) {
    console.error("This directory isn't linked to a Railway project. Run `railway link` or `jig deploy` first.")
    process.exit(1)
  }
  console.log(`  Linked to: ${status.projectName} / ${status.serviceId.slice(0, 8)}\n`)
  const defaults = await writeDeployDefaults()
  console.log(`  Scheduler timezone default: ${defaults.timezone} (saved to SQLite on boot)\n`)

  // Without a /data volume, every redeploy wipes SQLite (password, OAuth
  // tokens, jigs). Auto-attach if missing — shadows whatever's in the
  // ephemeral /data (which was going to die at the next redeploy anyway),
  // and gives subsequent --updates real persistence.
  // Attaching shadows whatever is already at /data, so this must run only when
  // we KNOW there is no volume. A failed lookup is not that: it used to come
  // back as "no volumes" and would have attached a second mount over a healthy
  // instance's credentials, jigs, schedules, and history.
  let volumeAtData: boolean
  try {
    volumeAtData = await hasVolumeAtPath("/data")
  } catch (error) {
    console.error(`\nCould not check whether /data has a volume: ${(error as Error)?.message ?? error}`)
    console.error("Refusing to redeploy while the volume state is unknown, because attaching one")
    console.error("would shadow the existing /data and lose credentials, jigs, and history.")
    console.error("Check `railway volume list --json`, then re-run.")
    process.exit(1)
  }

  if (!volumeAtData) {
    console.log("No Railway volume at /data - auto-attaching before redeploy.")
    console.log("  SQLite (password, OAuth tokens, jigs) is lost on redeploy without a volume.")
    console.log("  Anything currently in the ephemeral /data will be shadowed by the new mount —")
    console.log("  you'll need to re-onboard once. Subsequent --updates will persist normally.\n")
    // `-s`/`-e` are parent-level flags on `railway volume`, not on `add`.
    // Order matters: `railway volume -s <svc> -e <env> add --mount-path /data`.
    const code = await railwayInteractive([
      "volume",
      "-s", status.serviceId,
      "-e", status.environmentId,
      "add", "--mount-path", "/data",
    ])
    const attached = code === 0 && await hasVolumeAtPath("/data").catch(() => false)
    if (!attached) {
      console.error("\nVolume attach failed. Attach it manually in the Railway dashboard, then re-run.")
      process.exit(1)
    }
    console.log("  ✓ Volume attached at /data.\n")
  }

  console.log("Uploading and deploying (Nixpacks; streams build logs)...")
  const code = await railwayInteractive(["up", "--ci", "--service", status.serviceId])
  if (code !== 0) {
    console.error("\nrailway up failed — see logs above.")
    process.exit(1)
  }

  // Best-effort health probe: find the manifest for this project, ping it.
  const { listRemotes } = await import("../cli-remote/manifest.js")
  const manifest = listRemotes().find((r) => r.public_url.length > 0 && r.target === "railway")
  if (manifest) {
    console.log(`\nWaiting for ${manifest.public_url}/api/health...`)
    for (let i = 0; i < 60; i++) {
      try {
        const res = await fetch(`${manifest.public_url}/api/health`, { cache: "no-store" })
        if (res.ok) {
          console.log("  ✓ Healthy.")
          break
        }
      } catch {}
      await new Promise((r) => setTimeout(r, 2000))
    }
    // The restart re-locked the instance; scheduled jigs stay paused until
    // it's unlocked. Ask here rather than leaving it to be noticed later.
    const { ensureUnlocked } = await import("../cli-remote/unlock.js")
    await ensureUnlocked(manifest)
  }
  console.log("\n  ✓ Redeploy complete.")
}

export async function runDeploy(targetArg?: string, options: DeployOptions = {}): Promise<void> {
  if (targetArg && targetArg !== "railway") {
    console.error(`Unknown target "${targetArg}". Only "railway" is supported in v1.`)
    process.exit(1)
  }
  assumeYes = Boolean(options.yes)

  console.log("jig deploy — provision a Railway-hosted instance.\n")

  // Step 1: railway CLI
  if (!(await isRailwayInstalled())) {
    const ok = await confirm("Railway CLI not found. Install @railway/cli via bun?", true)
    if (!ok) {
      console.error("Cancelled. Install it manually (`bun install -g @railway/cli`) and re-run `jig deploy`.")
      process.exit(1)
    }
    await installRailway()
  }

  // Step 2: login
  await ensureRailwayLogin()
  const railwayIdentity = await getRailwayIdentity()
  console.log(`Railway login: ${railwayIdentity ?? "identity unavailable"}`)
  const useScope = await confirm("Use this account and choose its workspace for the new project?", false)
  if (!useScope) {
    console.error("Cancelled. Re-run with --yes to deploy under this account, or `railway logout`, sign into the intended one, and re-run.")
    process.exit(1)
  }
  if (options.workspace) console.log(`Workspace: ${options.workspace}`)

  // Step 3: project name
  const defaultSlug = slugify(`jig-${Date.now().toString(36).slice(-4)}`)
  const rawSlug = await prompt("Project name", defaultSlug)
  const slug = slugify(rawSlug)
  const existingManifest = getRemote(slug)
  if (existingManifest) {
    console.log(
      `\nA local remote named "${slug}" already exists (${existingManifest.public_url || "no url"}).`,
    )
    const overwrite = await confirm("Remove it and redeploy from scratch?", true, { destructive: true })
    if (!overwrite) {
      console.error("Aborted. Pick a different project name and re-run `jig deploy`.")
      process.exit(1)
    }
    deleteRemote(slug)
    console.log(`  Removed ~/.config/jig/remotes/${slug}.json`)
  }

  // Step 3b: collision check — prior failed attempts tend to leave orphan
  // projects with the same name. Offer to delete them before re-creating.
  // The Railway CLI's delete is quirky (may pop an interactive picker, may
  // return non-zero after a successful delete, may stale-cache), so after
  // each attempt we re-query list --json and trust the server's view.
  {
    const existing = await findProjectsByName(slug)
    if (existing.length > 0) {
      console.log(
        `\nFound ${existing.length} existing Railway project(s) named "${slug}":`,
      )
      for (const p of existing) console.log(`  - ${p.id}`)
      const doDelete = await confirm("Delete them and continue?", true, { destructive: true })
      if (!doDelete) {
        console.error("Aborted. Pick a different project name and re-run `jig deploy`.")
        process.exit(1)
      }
      for (const p of existing) {
        // Refetch before acting — a prior iteration (or the interactive
        // picker during the previous delete) may have already removed this.
        const fresh = await listProjects()
        if (!fresh.find((cp) => cp.id === p.id)) {
          console.log(`  Already gone: ${p.id}`)
          continue
        }
        console.log(`  Deleting ${p.id}...`)
        await deleteProject(p.id).catch(() => false)
        // Authoritative check: is it actually gone?
        const after = await listProjects()
        if (after.find((ap) => ap.id === p.id)) {
          console.error(`  Delete didn't take effect for ${p.id}. Remove it via the Railway dashboard and retry.`)
          process.exit(1)
        }
      }
      // Final check: no remaining collisions.
      const remaining = await findProjectsByName(slug)
      if (remaining.length > 0) {
        console.error(`  Still found projects named "${slug}" after delete (${remaining.map((r) => r.id).join(", ")}). Investigate in the Railway dashboard.`)
        process.exit(1)
      }
    }
  }

  // Step 4: init
  console.log(`\nCreating Railway project "${slug}"...`)
  const initArgs = ["init", "--name", slug, ...(options.workspace ? ["-w", options.workspace] : [])]
  const initCode = await railwayInteractive(initArgs)
  if (initCode !== 0) {
    console.error("railway init failed.")
    process.exit(1)
  }

  // Step 4a: the service, from the published image. The setup code and the
  // timezone ride along as variables so they are there before the first boot.
  const setupCode = mintSetupCode()
  const timezone = detectRuntimeTimeZone()
  const { image, pinned } = await resolveDeployImage(PACKAGE_VERSION)
  console.log(`  Image: ${image}${pinned ? "" : " (this checkout's release is not published yet, using latest)"}`)
  const variables = { JIG_SETUP_CODE: setupCode, JIG_TIMEZONE: timezone }
  if (await getStatus()) {
    // An older CLI created a service during init; point it at the image instead of adding a second one.
    const existing = (await getStatus())!
    await setServiceVariables(existing.serviceId, variables)
    await setServiceImage({ serviceId: existing.serviceId, environmentId: existing.environmentId, image })
  } else {
    console.log(`  Creating service "${slug}"...`)
    const addCode = await addImageService(slug, image, variables)
    if (addCode !== 0) {
      console.error(`Could not create a service in "${slug}". Add one in the Railway dashboard and re-run \`jig deploy\`.`)
      process.exit(1)
    }
  }

  // Step 4b: link the service so later CLI calls target it without prompts.
  console.log(`  Linking cwd to service "${slug}"...`)
  await linkService(slug).catch(() => {
    console.log(`  (service link non-zero; continuing — may already be linked)`)
  })

  // Step 5: volume. Attaching one restarts the service, which is fine this early.
  console.log("\nAttaching /data volume...")
  let status: RailwayStatus | null = null
  for (let i = 0; i < 5 && !status; i++) {
    status = await getStatus()
    if (!status) await new Promise((r) => setTimeout(r, 2000))
  }
  try {
    await attachDataVolume(status)
  } catch (error) {
    console.error(`\n${(error as Error)?.message ?? error}`)
    process.exit(1)
  }
  // Authoritative check — a missing volume silently wipes SQLite on every
  // redeploy. Better to fail the deploy here than let onboarding evaporate
  // later.
  const volumesAfter = await listVolumes().catch((error) => {
    console.error(`\nCould not verify the volume: ${(error as Error)?.message ?? error}`)
    return [] as Awaited<ReturnType<typeof listVolumes>>
  })
  if (!volumesAfter.some((v) => v.mountPath === "/data")) {
    console.error("")
    console.error("Volume attach did NOT create a volume at /data.")
    console.error("Without it, every redeploy wipes SQLite (password, OAuth tokens, jigs).")
    console.error("Existing volumes on this project:")
    if (volumesAfter.length === 0) console.error("  (none)")
    else for (const v of volumesAfter) console.error(`  - ${v.name} @ ${v.mountPath || "?"} (${v.id})`)
    console.error("")
    console.error("Attach it manually in the Railway dashboard, then run `jig deploy --attach-volume`.")
    process.exit(1)
  }
  console.log(`  ✓ Volume attached at /data.`)

  // Step 6: public URL. API first (no prompt), the CLI as fallback.
  console.log("\nGenerating a public domain...")
  let publicUrl: string | null = null
  if (status) {
    publicUrl = await createServiceDomain({ environmentId: status.environmentId, serviceId: status.serviceId })
      .then((domain) => `https://${domain}`)
      .catch(() => null)
  }
  if (!publicUrl) {
    await railwayInteractive(["domain"]).catch(() => -1)
    publicUrl = await getPublicUrl()
  }
  if (!publicUrl) {
    console.error("Couldn't determine the public URL. Run `railway domain` manually, then re-run `jig deploy`.")
    process.exit(1)
  }

  // Step 7: wait for first health
  console.log(`\nWaiting for ${publicUrl}/api/health to respond (pulling the image and booting, usually under a minute)...`)
  const healthy = await waitForFirstHealth(publicUrl)
  if (!healthy) {
    console.log("Deploy didn't become healthy within 5 minutes. Check Railway logs — you can run `railway logs`.")
    console.log(`Continuing anyway. Your instance may still come up. Dashboard: ${publicUrl}`)
  }

  // Step 8: save manifest. Railway IDs are what `jig update` needs to switch the image.
  const manifest: RemoteManifest = {
    handle: slug,
    target: "railway",
    public_url: publicUrl,
    created_at: new Date().toISOString(),
    image,
    setup_code: setupCode,
    railway: status
      ? {
          project_id: status.projectId,
          service_id: status.serviceId,
          environment_id: status.environmentId,
          token: "",
        }
      : undefined,
  }
  saveRemote(manifest)

  console.log(`\n  ✓ Deployed.\n`)
  console.log(`  Dashboard:   ${publicUrl}`)
  console.log(`  Setup code:  ${setupCode}`)
  console.log(`  Manifest:    ~/.config/jig/remotes/${slug}.json`)
  console.log(`  Next:        open the dashboard, enter the setup code, choose a password.`)
  console.log(`               Then \`jig setup ${slug}\` pairs this machine by itself and walks the rest.`)
  console.log(`  Later:       \`jig update ${slug}\` moves it to the next release image.`)
}

const PACKAGE_VERSION: string = (() => {
  try {
    return (JSON.parse(readFileSync(`${PROJECT_ROOT}/package.json`, "utf-8")) as { version?: string }).version ?? "0.0.0"
  } catch {
    return "0.0.0"
  }
})()

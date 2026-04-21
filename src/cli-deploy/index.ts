/**
 * `jig deploy` — interactive wizard that provisions a Railway instance.
 *
 * Zero required env vars. The user picks a project name and we wrap the
 * `railway` CLI end-to-end. Auth comes from `railway login`.
 *
 * Flow:
 *   1. Detect `railway` binary; offer `bun install -g @railway/cli`.
 *   2. `railway login` (opens browser) if not already logged in.
 *   3. Prompt for a project slug.
 *   4. `railway init --name <slug>`.
 *   5. `railway volume add <slug>-data --mount-path /data`.
 *   6. `railway up --detach` — uploads local repo, Railway builds + runs.
 *   7. `railway domain` → public URL.
 *   8. Wait for /api/health to respond.
 *   9. Save manifest at ~/.config/jig/remotes/<slug>.json.
 *
 * Post-wizard: user opens the URL, sets a password, adds the OpenRouter key
 * and connects services from the dashboard.
 */
import { createInterface } from "node:readline/promises"
import { deleteRemote, getRemote, saveRemote, type RemoteManifest } from "../cli-remote/manifest.js"
import {
  deleteProject,
  findProjectsByName,
  getPublicUrl,
  getStatus,
  installRailway,
  isLoggedIn,
  isRailwayInstalled,
  linkService,
  listProjects,
  railwayInteractive,
} from "./railway-cli.js"

async function prompt(question: string, defaultValue?: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const suffix = defaultValue ? ` [${defaultValue}]` : ""
  const answer = (await rl.question(`${question}${suffix}: `)).trim()
  rl.close()
  return answer || (defaultValue ?? "")
}

async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const suffix = defaultYes ? " [Y/n]" : " [y/N]"
  const ans = await prompt(`${question}${suffix}`)
  if (!ans) return defaultYes
  return ans.toLowerCase().startsWith("y")
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
  if (args.includes("--update")) {
    await runUpdateInPlace()
    return
  }
  const target = args.find((a) => !a.startsWith("--"))
  await runDeploy(target)
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
  if (!(await isLoggedIn())) {
    console.error("Not logged in to Railway. Run `railway login` and retry.")
    process.exit(1)
  }

  const status = await getStatus()
  if (!status) {
    console.error("This directory isn't linked to a Railway project. Run `railway link` or `jig deploy` first.")
    process.exit(1)
  }
  console.log(`  Linked to: ${status.projectName} / ${status.serviceId.slice(0, 8)}\n`)

  console.log("Uploading and deploying (Nixpacks; streams build logs)...")
  const code = await railwayInteractive(["up", "--ci"])
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
  }
  console.log("\n  ✓ Redeploy complete.")
}

export async function runDeploy(targetArg?: string): Promise<void> {
  if (targetArg && targetArg !== "railway") {
    console.error(`Unknown target "${targetArg}". Only "railway" is supported in v1.`)
    process.exit(1)
  }

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
  if (!(await isLoggedIn())) {
    console.log("Opening Railway login in your browser...")
    const code = await railwayInteractive(["login"])
    if (code !== 0) {
      console.error("railway login failed. Re-run `jig deploy` once you're logged in.")
      process.exit(1)
    }
  }

  // Step 3: project name
  const defaultSlug = slugify(`jig-${Date.now().toString(36).slice(-4)}`)
  const rawSlug = await prompt("Project name", defaultSlug)
  const slug = slugify(rawSlug)
  const existingManifest = getRemote(slug)
  if (existingManifest) {
    console.log(
      `\nA local remote named "${slug}" already exists (${existingManifest.public_url || "no url"}).`,
    )
    const overwrite = await confirm("Remove it and redeploy from scratch?", true)
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
      const doDelete = await confirm("Delete them and continue?", true)
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
  const initCode = await railwayInteractive(["init", "--name", slug])
  if (initCode !== 0) {
    console.error("railway init failed.")
    process.exit(1)
  }

  // Step 4b: link the newly-created service so subsequent volume/up calls
  // target it without interactive prompts. Railway creates a service named
  // after the project during init.
  console.log(`  Linking cwd to service "${slug}"...`)
  await linkService(slug).catch(() => {
    console.log(`  (service link non-zero; continuing — may already be linked)`)
  })

  // Step 5: volume (v4 CLI: `railway volume add --mount-path <path>`; name is prompted)
  console.log("\nAttaching /data volume (enter any name when prompted)...")
  const volumeCode = await railwayInteractive(["volume", "add", "--mount-path", "/data"])
  if (volumeCode !== 0) {
    console.log("  (volume attach reported non-zero; continuing — may already exist or need manual attach)")
  }

  // Step 6: deploy. `--ci` streams build logs then exits with the build
  // result code — we get live progress AND a clean finish signal.
  console.log("\nUploading and deploying (Nixpacks; streams build logs, first build ~2 min)...")
  const upCode = await railwayInteractive(["up", "--ci"])
  if (upCode !== 0) {
    console.error("railway up failed during build.")
    process.exit(1)
  }

  // Step 7: resolve public URL + (best-effort) IDs. status may lag briefly
  // after `up` returns — retry a few times before giving up.
  let status = null
  for (let i = 0; i < 5; i++) {
    status = await getStatus()
    if (status) break
    await new Promise((r) => setTimeout(r, 2000))
  }
  console.log("\nGenerating a public domain...")
  await railwayInteractive(["domain"]).catch(() => -1)
  const publicUrl = await getPublicUrl()
  if (!publicUrl) {
    console.error("Couldn't determine the public URL. Run `railway domain` manually, then re-run `jig deploy`.")
    process.exit(1)
  }

  // Step 8: wait for first health
  console.log(`\nWaiting for ${publicUrl}/api/health to respond (building may take a few minutes)...`)
  const healthy = await waitForFirstHealth(publicUrl)
  if (!healthy) {
    console.log("Deploy didn't become healthy within 5 minutes. Check Railway logs — you can run `railway logs`.")
    console.log(`Continuing anyway. Your instance may still come up. Dashboard: ${publicUrl}`)
  }

  // Step 9: save manifest. Railway IDs are optional — without them, `jig
  // update` falls back to cwd-based linking (run from this checkout).
  const manifest: RemoteManifest = {
    handle: slug,
    target: "railway",
    public_url: publicUrl,
    created_at: new Date().toISOString(),
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
  console.log(`  Dashboard:  ${publicUrl}`)
  console.log(`  Manifest:   ~/.config/jig/remotes/${slug}.json`)
  console.log(`  Next:       open the URL, set a password, add your OpenRouter API key, connect services.`)
  console.log(`  Later:      run \`jig update\` to advance to the next release.`)
}

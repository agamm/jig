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
import { saveRemote, getRemote, type RemoteManifest } from "../cli-remote/manifest.js"
import {
  getPublicUrl,
  getStatus,
  installRailway,
  isLoggedIn,
  isRailwayInstalled,
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
  if (getRemote(slug)) {
    console.error(`A remote named "${slug}" already exists at ~/.config/jig/remotes/${slug}.json. Pick another name.`)
    process.exit(1)
  }

  // Step 4: init
  console.log(`\nCreating Railway project "${slug}"...`)
  const initCode = await railwayInteractive(["init", "--name", slug])
  if (initCode !== 0) {
    console.error("railway init failed.")
    process.exit(1)
  }

  // Step 5: volume (v4 CLI: `railway volume add --mount-path <path>`; name is prompted)
  console.log("\nAttaching /data volume (enter any name when prompted)...")
  const volumeCode = await railwayInteractive(["volume", "add", "--mount-path", "/data"])
  if (volumeCode !== 0) {
    console.log("  (volume attach reported non-zero; continuing — may already exist or need manual attach)")
  }

  // Step 6: deploy
  console.log("\nUploading and deploying (Nixpacks; first build ~2 min)...")
  const upCode = await railwayInteractive(["up", "--detach"])
  if (upCode !== 0) {
    console.error("railway up failed.")
    process.exit(1)
  }

  // Step 7: resolve public URL + (best-effort) IDs
  // `railway status --json` isn't supported by every CLI version; we save
  // whatever we can and fall back to cwd-based linking for `jig update`.
  const status = await getStatus()
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

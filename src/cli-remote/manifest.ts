/**
 * Remote manifest — one file per deployed jig instance at
 * ~/.config/jig/remotes/<handle>.json. Written by `jig deploy`, read by
 * `jig update` / `jig status` / `jig doctor`.
 *
 * File mode is 600 — it holds the admin-key equivalent (platform API token,
 * such as a Railway token) that lets the CLI redeploy the service.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from "node:fs"
import { join } from "node:path"
import { homedir } from "node:os"

export type RemoteTarget = "railway"

export interface RemoteManifest {
  /** Short handle used as the filename and for command line targeting. */
  handle: string
  /** Platform identifier. Only "railway" for v1. */
  target: RemoteTarget
  /** The user-facing HTTPS URL jig is reachable at. */
  public_url: string
  /** ISO timestamp when this remote was first created. */
  created_at: string
  /** Container image the service runs (image-based deploys); absent for source-built instances. */
  image?: string
  /**
   * The first-boot setup code this machine chose for the instance. Lets the
   * deploying CLI pair itself once the owner has set a password, so no code
   * or password ever travels through a chat.
   */
  setup_code?: string
  /** Railway project / service / environment IDs (target-specific). */
  railway?: {
    project_id: string
    service_id: string
    environment_id: string
    token: string
  }
  /**
   * Signed admin session cookie (`jig-admin` value) from POST /api/unlock.
   * Issued by the remote's session.ts; HMAC-signed; default 30-day TTL.
   * Populated by `jig pair` or `jig unlock`; used by every command that talks to the remote
   * to authenticate against admin-only endpoints.
   */
  session_cookie?: string
}

const remotesDir = (): string =>
  process.env.JIG_REMOTES_DIR || join(homedir(), ".config", "jig", "remotes")

function ensureDir(): void {
  const dir = remotesDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 })
}

export function listRemotes(): RemoteManifest[] {
  const dir = remotesDir()
  if (!existsSync(dir)) return []
  const files = readdirSync(dir).filter((f) => f.endsWith(".json"))
  return files.map((f) => JSON.parse(readFileSync(join(dir, f), "utf-8")) as RemoteManifest)
}

export function getRemote(handle: string): RemoteManifest | null {
  const path = join(remotesDir(), `${handle}.json`)
  if (!existsSync(path)) return null
  return JSON.parse(readFileSync(path, "utf-8")) as RemoteManifest
}

export function saveRemote(manifest: RemoteManifest): void {
  ensureDir()
  const path = join(remotesDir(), `${manifest.handle}.json`)
  writeFileSync(path, JSON.stringify(manifest, null, 2))
  chmodSync(path, 0o600)
}

export function deleteRemote(handle: string): void {
  const path = join(remotesDir(), `${handle}.json`)
  rmSync(path, { force: true })
}

/** Persist or clear the admin session cookie for a remote. */
export function setSessionCookie(handle: string, cookie: string | undefined): void {
  const manifest = getRemote(handle)
  if (!manifest) throw new Error(`No remote named "${handle}"`)
  if (cookie) manifest.session_cookie = cookie
  else delete manifest.session_cookie
  saveRemote(manifest)
}

/** Pick the single active remote; exits if zero or asks if multiple. */
export function resolveActiveRemote(handle?: string): RemoteManifest {
  const remotes = listRemotes()
  if (remotes.length === 0) {
    throw new Error(
      "No remotes configured. Run `jig deploy` to provision one.",
    )
  }
  if (handle) {
    const match = remotes.find((r) => r.handle === handle)
    if (!match) throw new Error(`No remote named "${handle}". Known: ${remotes.map((r) => r.handle).join(", ")}`)
    return match
  }
  if (remotes.length === 1) return remotes[0]
  throw new Error(
    `Multiple remotes configured (${remotes.map((r) => r.handle).join(", ")}). Choose one explicitly.`,
  )
}

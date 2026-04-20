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
  /** Railway project / service / environment IDs (target-specific). */
  railway?: {
    project_id: string
    service_id: string
    environment_id: string
    token: string
  }
}

const remotesDir = (): string => join(homedir(), ".config", "jig", "remotes")

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
    `Multiple remotes configured (${remotes.map((r) => r.handle).join(", ")}). Pass one: jig update <handle>`,
  )
}

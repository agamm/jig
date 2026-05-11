import { existsSync, readFileSync } from "fs"
import { rm, stat, writeFile } from "fs/promises"
import { join } from "path"
import type { DataStorageHealth } from "../../shared/api.js"
import { DATA_DIR } from "../config/paths.js"
import { isServiceMode } from "../config/runtime.js"

export const DATA_VOLUME_FIX_COMMAND = "jig deploy --attach-volume && jig deploy --update"

export async function getDataStorageHealth(): Promise<DataStorageHealth> {
  if (!isServiceMode()) {
    return {
      ok: true,
      path: DATA_DIR,
      mounted: true,
      writable: true,
      persistent: true,
    }
  }

  const base = {
    path: DATA_DIR,
    mounted: isMountedAt(DATA_DIR),
    writable: false,
    persistent: false,
  }

  if (!existsSync(DATA_DIR)) {
    return failStorage({
      ...base,
      message: "Persistent data directory /data does not exist.",
    })
  }

  try {
    const s = await stat(DATA_DIR)
    if (!s.isDirectory()) {
      return failStorage({
        ...base,
        message: "/data exists but is not a directory.",
      })
    }
  } catch (error: any) {
    return failStorage({
      ...base,
      message: `Cannot inspect /data: ${error?.message ?? error}`,
    })
  }

  const writable = await canWriteDataDir()
  const mounted = base.mounted
  const persistent = mounted && writable
  if (!persistent) {
    return failStorage({
      ...base,
      mounted,
      writable,
      persistent,
      message: !mounted
        ? "No persistent Railway volume is mounted at /data. Data saved here will be lost on redeploy."
        : "The /data volume is mounted but not writable.",
    })
  }

  return {
    ok: true,
    path: DATA_DIR,
    mounted,
    writable,
    persistent,
  }
}

export async function assertPersistentDataStorage(): Promise<void> {
  const health = await getDataStorageHealth()
  if (health.ok) return
  throw new Error(`${health.message} Run: ${health.action}`)
}

function failStorage(input: Omit<DataStorageHealth, "ok" | "action">): DataStorageHealth {
  return {
    ...input,
    ok: false,
    action: DATA_VOLUME_FIX_COMMAND,
  }
}

async function canWriteDataDir(): Promise<boolean> {
  const path = join(DATA_DIR, `.jig-storage-check-${process.pid}-${Date.now()}`)
  try {
    await writeFile(path, "ok", { mode: 0o600 })
    await rm(path, { force: true })
    return true
  } catch {
    return false
  }
}

function isMountedAt(path: string): boolean {
  try {
    const mountInfo = readFileSync("/proc/self/mountinfo", "utf8")
    return mountInfo.split("\n").some((line) => {
      const parts = line.split(" ")
      return decodeMountPath(parts[4] ?? "") === path
    })
  } catch {
    return false
  }
}

function decodeMountPath(path: string): string {
  return path.replace(/\\040/g, " ")
}

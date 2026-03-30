import { existsSync } from "fs"
import { join } from "path"
import { JIGS_DIR } from "../config/paths.js"
import { clearStepCache } from "../db.js"

export async function writeJigSource(
  filePath: string,
  code: string,
  options?: {
    jigId?: string
    entity?: string | null
    commitMessage?: string
    commit?: boolean
  }
): Promise<void> {
  const jigId = options?.jigId
  const entity = options?.entity ?? null

  if (entity) {
    const dir = join(JIGS_DIR, jigId ?? "")
    if (!existsSync(dir)) {
      await Bun.spawn(["mkdir", "-p", dir]).exited
    }
  }

  await Bun.write(filePath, code)

  if (jigId) {
    try {
      clearStepCache(jigId, entity)
    } catch {}
  }

  if (!options?.commit || !jigId || !existsSync(join(JIGS_DIR, ".git"))) return

  const relPath = entity ? join(jigId, `${entity}.ts`) : `${jigId}.ts`
  const msg = options.commitMessage ?? `jig: ${jigId} — update`
  await Bun.spawn(["git", "add", relPath], { cwd: JIGS_DIR }).exited
  await Bun.spawn(["git", "commit", "-m", msg], {
    cwd: JIGS_DIR,
    stdout: "ignore",
    stderr: "ignore",
  }).exited
}

import { existsSync } from "fs"
import { join } from "path"
import { JIGS_DIR } from "../config/paths.js"
import { clearStepCache } from "../db.js"

export async function writeJigSource(
  filePath: string,
  code: string,
  options?: {
    jigId?: string
    commitMessage?: string
    commitPrompt?: string | null
    commit?: boolean
  }
): Promise<void> {
  const jigId = options?.jigId

  await Bun.write(filePath, code)

  if (jigId) {
    try {
      clearStepCache(jigId)
    } catch {}
  }

  if (!options?.commit || !jigId || !existsSync(join(JIGS_DIR, ".git"))) return

  const relPath = `${jigId}.ts`
  const msg = options.commitMessage ?? `jig: ${jigId} — update`
  const addProc = Bun.spawn(["git", "add", relPath], {
    cwd: JIGS_DIR,
    stdout: "pipe",
    stderr: "pipe",
  })
  const addError = await new Response(addProc.stderr).text()
  const addExitCode = await addProc.exited
  if (addExitCode !== 0) {
    throw new Error(addError.trim() || `git add failed for ${relPath}`)
  }

  const diffProc = Bun.spawn(["git", "diff", "--cached", "--quiet", "--", relPath], {
    cwd: JIGS_DIR,
    stdout: "ignore",
    stderr: "pipe",
  })
  const diffError = await new Response(diffProc.stderr).text()
  const diffExitCode = await diffProc.exited
  if (diffExitCode === 0) return
  if (diffExitCode !== 1) {
    throw new Error(diffError.trim() || `git diff failed for ${relPath}`)
  }

  const trimmedPrompt = options.commitPrompt?.trim()
  const commitArgs = ["git", "commit", "-m", msg]
  if (trimmedPrompt) {
    commitArgs.push("-m", `jig-meta:${JSON.stringify({ prompt: trimmedPrompt })}`)
  }

  const commitProc = Bun.spawn(commitArgs, {
    cwd: JIGS_DIR,
    stdout: "ignore",
    stderr: "pipe",
  })
  const commitError = await new Response(commitProc.stderr).text()
  const commitExitCode = await commitProc.exited
  if (commitExitCode !== 0) {
    throw new Error(commitError.trim() || `git commit failed for ${relPath}`)
  }
}

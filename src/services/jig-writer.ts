import { existsSync, mkdirSync, rmSync } from "fs"
import { join } from "path"
import { JIGS_DIR } from "../config/paths.js"
import { clearStepCache } from "../db.js"

const GIT_COMMIT_IDENTITY_ARGS = [
  "-c", "user.name=Jig",
  "-c", "user.email=jig@local",
]

async function runGit(
  args: string[],
  cwd = JIGS_DIR
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

async function runGitCommit(
  args: string[],
  cwd = JIGS_DIR
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return runGit([...GIT_COMMIT_IDENTITY_ARGS, ...args], cwd)
}

export async function ensureJigsGitRepo(): Promise<boolean> {
  return ensureJigsGitRepoAt(JIGS_DIR)
}

export async function ensureJigsGitRepoAt(jigsDir: string): Promise<boolean> {
  if (existsSync(join(jigsDir, ".git"))) return true

  mkdirSync(jigsDir, { recursive: true })

  const init = await runGit(["init"], jigsDir)
  if (init.exitCode !== 0) return false

  await runGit(["add", "-A"], jigsDir)
  await runGitCommit(["commit", "-m", "Initial jig snapshot", "--allow-empty"], jigsDir)
  return true
}

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
  const shouldCommit = Boolean(options?.commit && jigId)
  const gitReady = shouldCommit ? await ensureJigsGitRepo() : false

  await Bun.write(filePath, code)

  if (jigId) {
    try {
      clearStepCache(jigId)
    } catch {}
  }

  if (!shouldCommit || !jigId || !gitReady) return

  const relPath = `${jigId}.ts`
  const msg = options.commitMessage ?? `jig: ${jigId} — update`
  const add = await runGit(["add", relPath])
  if (add.exitCode !== 0) {
    throw new Error(add.stderr.trim() || `git add failed for ${relPath}`)
  }

  const diff = await runGit(["diff", "--cached", "--quiet", "--", relPath])
  if (diff.exitCode === 0) return
  if (diff.exitCode !== 1) {
    throw new Error(diff.stderr.trim() || `git diff failed for ${relPath}`)
  }

  const trimmedPrompt = options.commitPrompt?.trim()
  const commitArgs = ["commit", "-m", msg]
  if (trimmedPrompt) {
    commitArgs.push("-m", `jig-meta:${JSON.stringify({ prompt: trimmedPrompt })}`)
  }

  const commit = await runGitCommit(commitArgs)
  if (commit.exitCode !== 0) {
    throw new Error(commit.stderr.trim() || `git commit failed for ${relPath}`)
  }
}

export async function renameJigFile(
  oldJigId: string,
  newJigId: string,
  newCode: string,
  options?: {
    commitMessage?: string
    commitPrompt?: string | null
  }
): Promise<void> {
  const oldPath = join(JIGS_DIR, `${oldJigId}.ts`)
  const newPath = join(JIGS_DIR, `${newJigId}.ts`)
  const gitReady = await ensureJigsGitRepo()

  await Bun.write(newPath, newCode)
  rmSync(oldPath, { force: true })

  try { clearStepCache(oldJigId) } catch {}
  try { clearStepCache(newJigId) } catch {}

  if (!gitReady) return

  const relOld = `${oldJigId}.ts`
  const relNew = `${newJigId}.ts`
  const add = await runGit(["add", relOld, relNew])
  if (add.exitCode !== 0) {
    throw new Error(add.stderr.trim() || `git add failed for ${relOld}, ${relNew}`)
  }

  const diff = await runGit(["diff", "--cached", "--quiet"])
  if (diff.exitCode === 0) return
  if (diff.exitCode !== 1) {
    throw new Error(diff.stderr.trim() || `git diff failed for rename ${oldJigId} → ${newJigId}`)
  }

  const msg = options?.commitMessage ?? `jig: ${oldJigId} → ${newJigId}`
  const trimmedPrompt = options?.commitPrompt?.trim()
  const commitArgs = ["commit", "-m", msg]
  if (trimmedPrompt) {
    commitArgs.push("-m", `jig-meta:${JSON.stringify({ prompt: trimmedPrompt })}`)
  }
  const commit = await runGitCommit(commitArgs)
  if (commit.exitCode !== 0) {
    throw new Error(commit.stderr.trim() || `git commit failed for rename ${oldJigId} → ${newJigId}`)
  }
}

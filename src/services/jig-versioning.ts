import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { JigVersion, JigVersionDetail, RestoreJigVersionResult } from "../../shared/api.js"
import { JIGS_DIR } from "../config/paths.js"
import { getJigFilePath, getJigRelativePath, resolveJigPath } from "../domain/jig-source.js"
import { invalidateJigsCache } from "../discover.js"
import { ApiError } from "../server/http.js"
import { ensureJigsGitRepo, writeJigSource } from "./jig-writer.js"

export function extractPromptFromCommitBody(body: string): string | null {
  const metaLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("jig-meta:"))

  if (!metaLine) return null

  try {
    const raw = metaLine.slice("jig-meta:".length)
    const meta = JSON.parse(raw) as { prompt?: unknown }
    return typeof meta.prompt === "string" && meta.prompt.trim() ? meta.prompt.trim() : null
  } catch {
    return null
  }
}

async function ensureGitHistory() {
  if (!existsSync(join(JIGS_DIR, ".git")) && !(await ensureJigsGitRepo())) {
    throw new ApiError(404, "No version history")
  }
}

function ensureSha(sha: string) {
  if (!/^[0-9a-f]+$/i.test(sha)) {
    throw new ApiError(400, "Invalid sha")
  }
}

async function runGit(args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(args, { cwd: JIGS_DIR, stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  return { stdout, exitCode }
}

async function readVersionCode(relPath: string, sha: string): Promise<string> {
  const { stdout, exitCode } = await runGit(["git", "show", `${sha}:${relPath}`])
  if (exitCode !== 0) {
    throw new ApiError(404, "Version not found")
  }
  return stdout
}

async function readVersionPrompt(sha: string): Promise<string | null> {
  const { stdout, exitCode } = await runGit(["git", "show", "-s", "--format=%B", sha])
  if (exitCode !== 0) {
    throw new ApiError(404, "Version not found")
  }
  return extractPromptFromCommitBody(stdout)
}

export async function listJigVersions(jigId: string): Promise<JigVersion[]> {
  await ensureGitHistory()
  const relPath = getJigRelativePath(jigId)
  if (!relPath) throw new ApiError(400, "Invalid jig path")

  const { stdout, exitCode } = await runGit(["git", "log", "--format=%H|%aI|%s", "--", relPath])
  if (exitCode !== 0) return []
  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha, date, ...msgParts] = line.split("|")
      return { sha, date, message: msgParts.join("|") }
    })
}

export async function getJigVersionDetail(jigId: string, sha: string): Promise<JigVersionDetail> {
  await ensureGitHistory()
  ensureSha(sha)

  const relPath = getJigRelativePath(jigId)
  if (!relPath) throw new ApiError(400, "Invalid jig path")

  const code = await readVersionCode(relPath, sha)
  const prompt = await readVersionPrompt(sha)
  const filePath = getJigFilePath(jigId) ?? resolveJigPath(jigId)
  const currentCode = existsSync(filePath) ? readFileSync(filePath, "utf-8") : ""
  const hasChanges = currentCode !== code

  if (!hasChanges) {
    return { sha, code, diff: "", hasChanges: false, prompt }
  }

  const { stdout } = await runGit(["git", "diff", "--no-ext-diff", "--unified=3", sha, "--", relPath])
  return { sha, code, diff: stdout, hasChanges: true, prompt }
}

export async function restoreJigVersion(jigId: string, sha: string): Promise<RestoreJigVersionResult> {
  await ensureGitHistory()
  ensureSha(sha)

  const relPath = getJigRelativePath(jigId)
  if (!relPath) throw new ApiError(400, "Invalid jig path")

  const code = await readVersionCode(relPath, sha)
  const filePath = getJigFilePath(jigId) ?? resolveJigPath(jigId)
  const currentCode = existsSync(filePath) ? readFileSync(filePath, "utf-8") : ""

  if (currentCode === code) {
    return { ok: true, sha }
  }

  await writeJigSource(filePath, code, {
    jigId,
    commit: true,
    commitMessage: `jig: ${jigId} — restore ${sha.slice(0, 7)}`,
  })

  invalidateJigsCache()
  return { ok: true, sha }
}

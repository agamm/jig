/**
 * One-time migration: walks the legacy `jigs/*.ts` files + embedded git repo
 * and ingests them into the new jig_versions/jigs tables.
 *
 * Idempotent — exits early if any jigs row already exists. Safe to call on
 * every boot. After this lands, the filesystem files are no longer the source
 * of truth, just a safety-net archive.
 */
import { createHash } from "crypto"
import { existsSync, readdirSync, statSync } from "fs"
import { join } from "path"
import { openDb } from "../db.js"
import { JIGS_DIR } from "../config/paths.js"
import { getJigRow, importVersion, setActiveVersion } from "./jig-store.js"
import { prettifyId } from "../domain/jig-source.js"

export function extractPromptFromCommitBody(body: string): string | null {
  const metaLine = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("jig-meta:"))
  if (!metaLine) return null
  try {
    const meta = JSON.parse(metaLine.slice("jig-meta:".length)) as { prompt?: unknown }
    return typeof meta.prompt === "string" && meta.prompt.trim() ? meta.prompt.trim() : null
  } catch {
    return null
  }
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" })
  const stdout = await new Response(proc.stdout).text()
  const exitCode = await proc.exited
  return { stdout, exitCode }
}

interface ImportSummary {
  jigsImported: number
  versionsImported: number
  jigsSkipped: number
}

function hashCode(code: string): string {
  return createHash("sha1").update(code).digest("hex")
}

function listLegacyJigFiles(jigsDir: string): string[] {
  if (!existsSync(jigsDir)) return []
  const names: string[] = []
  for (const name of readdirSync(jigsDir)) {
    if (!name.endsWith(".ts")) continue
    if (name.startsWith("_")) continue
    const full = join(jigsDir, name)
    try {
      if (!statSync(full).isFile()) continue
    } catch { continue }
    names.push(name.replace(/\.ts$/, ""))
  }
  return names
}

async function importJig(jigId: string, hasGit: boolean, jigsDir: string): Promise<number> {
  const relPath = `${jigId}.ts`
  const filePath = join(jigsDir, relPath)

  if (!hasGit) {
    // No git history — import the current file as a single version.
    const code = await Bun.file(filePath).text()
    const { versionId } = importVersion({
      jigId,
      name: prettifyId(jigId),
      code,
      message: "imported (no git history)",
      prompt: null,
      parentId: null,
      createdAt: Date.now(),
    })
    setActiveVersion(jigId, versionId)
    return 1
  }

  const log = await runGit(
    ["log", "--reverse", "--format=%H|%aI|%s", "--", relPath],
    jigsDir,
  )
  if (log.exitCode !== 0 || !log.stdout.trim()) {
    // Git has no history for this file — fall back to current contents.
    const code = await Bun.file(filePath).text()
    const { versionId } = importVersion({
      jigId,
      name: prettifyId(jigId),
      code,
      message: "imported (no commit history)",
      prompt: null,
      parentId: null,
      createdAt: Date.now(),
    })
    setActiveVersion(jigId, versionId)
    return 1
  }

  let lastHash: string | null = null
  let parentId: number | null = null
  let imported = 0
  let lastVersionId: number | null = null

  for (const line of log.stdout.trim().split("\n")) {
    const [sha, iso, ...rest] = line.split("|")
    const message = rest.join("|").trim() || null

    const show = await runGit(["show", `${sha}:${relPath}`], jigsDir)
    if (show.exitCode !== 0) continue
    const code = show.stdout
    const codeHash = hashCode(code)
    if (codeHash === lastHash) continue  // dedupe no-op commits

    // pull commit body for jig-meta prompt
    const body = await runGit(["show", "-s", "--format=%B", sha], jigsDir)
    const prompt = body.exitCode === 0 ? extractPromptFromCommitBody(body.stdout) : null

    const { versionId } = importVersion({
      jigId,
      name: prettifyId(jigId),
      code,
      message,
      prompt,
      parentId,
      createdAt: new Date(iso).getTime() || Date.now(),
    })
    lastHash = codeHash
    parentId = versionId
    lastVersionId = versionId
    imported++
  }

  if (lastVersionId != null) {
    // Make sure the active code matches the working tree, not just the last
    // commit — handle uncommitted local edits in the legacy jigs/ dir.
    const workingCode = await Bun.file(filePath).text().catch(() => null)
    if (workingCode != null && hashCode(workingCode) !== lastHash) {
      const { versionId } = importVersion({
        jigId,
        name: prettifyId(jigId),
        code: workingCode,
        message: "imported uncommitted working-tree changes",
        prompt: null,
        parentId: lastVersionId,
        createdAt: Date.now(),
      })
      lastVersionId = versionId
      imported++
    }
    setActiveVersion(jigId, lastVersionId)
  }
  return imported
}

/**
 * Sync every legacy `jigs/*.ts` into the store. Runs on every boot, not just
 * first — so jigs that escaped a previous run (or were added later) get
 * pulled in. Per-jig idempotent: jigs already present in the store are
 * skipped. Each newly-imported jig pulls its git history if available.
 */
export async function syncLegacyJigs(jigsDir: string = JIGS_DIR): Promise<ImportSummary | null> {
  const summary: ImportSummary = { jigsImported: 0, versionsImported: 0, jigsSkipped: 0 }

  const legacyIds = listLegacyJigFiles(jigsDir)
  if (legacyIds.length === 0) return summary

  const hasGit = existsSync(join(jigsDir, ".git"))

  for (const jigId of legacyIds) {
    if (getJigRow(jigId)) continue  // already in the store
    try {
      const versions = await importJig(jigId, hasGit, jigsDir)
      summary.jigsImported++
      summary.versionsImported += versions
    } catch (err: any) {
      console.warn(`[migration] failed to import ${jigId}: ${err?.message ?? err}`)
      summary.jigsSkipped++
    }
  }
  return summary
}

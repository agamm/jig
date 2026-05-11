import { mkdir, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, join } from "node:path"
import { pathToFileURL } from "node:url"
import { CONNECTIONS_DIR, PROJECT_ROOT } from "../config/paths.js"

const RUNTIME_JIG_DIR = join(tmpdir(), "jig-runtime")

function fileUrl(path: string): string {
  return pathToFileURL(path).href
}

export function rewriteJigRuntimeImports(source: string): string {
  return source
    .replace(/(["'])@jig\/sdk\1/g, (_match, quote: string) => (
      `${quote}${fileUrl(join(PROJECT_ROOT, "src/index.ts"))}${quote}`
    ))
    .replace(/(["'])@jig\/connections\/([A-Za-z0-9_-]+)(?:\.(?:js|ts))?\1/g, (_match, quote: string, serverName: string) => (
      `${quote}${fileUrl(join(CONNECTIONS_DIR, `${serverName}.ts`))}${quote}`
    ))
}

export async function materializeJigWithRuntimeImports(jigPath: string, source: string): Promise<string> {
  const rewritten = rewriteJigRuntimeImports(source)
  if (rewritten === source) return jigPath

  await mkdir(RUNTIME_JIG_DIR, { recursive: true })
  const safeBase = basename(jigPath).replace(/[^A-Za-z0-9_.-]+/g, "-")
  const runtimePath = join(
    RUNTIME_JIG_DIR,
    `${safeBase}-${Date.now()}-${Math.random().toString(36).slice(2)}.ts`
  )
  await writeFile(runtimePath, rewritten)
  return runtimePath
}

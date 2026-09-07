/**
 * `jig visualize <name|file.ts> [-v | -vv] [--json] [--handle=<name> | --local]`
 *
 * Draws a jig's flow from its source: one box per step, AI or code, what each
 * touches. Reads a local .ts file when given one, otherwise the active version
 * on the paired instance (or this machine with --local).
 */
import { existsSync, readFileSync } from "node:fs"
import { analyzeJigFlow } from "../domain/jig-flow.js"
import { renderFlow, type DetailLevel } from "./render.js"

const USAGE = "Usage: jig visualize <name|file.ts> [-v | -vv] [--json] [--handle=<name> | --local]"

export async function runVisualize(args: string[], localBase: string): Promise<number> {
  const target = args.find((a) => !a.startsWith("-"))
  if (!target) {
    console.error(USAGE)
    return 1
  }
  const level: DetailLevel = args.includes("-vv") || args.includes("--level=3") ? 3 : args.includes("-v") || args.includes("--level=2") ? 2 : 1

  let code: string
  let defaultModel: string | undefined
  if (/\.ts$/.test(target) && existsSync(target)) {
    code = readFileSync(target, "utf8")
  } else {
    const { resolveAuthoringTarget } = await import("../cli-agent/target.js")
    const where = resolveAuthoringTarget(args, localBase)
    if (where.remote) {
      const res = await fetch(`${where.base}/api/jigs/${encodeURIComponent(target)}`, { headers: where.headers })
      if (!res.ok) {
        console.error(`Could not read ${target} from ${where.label}: HTTP ${res.status}. Is it a jig id? A local file needs a .ts path.`)
        return 1
      }
      code = ((await res.json()) as { code: string }).code
      const models = await fetch(`${where.base}/api/models`, { headers: where.headers }).then((r) => (r.ok ? r.json() : null)).catch(() => null)
      defaultModel = (models as { main?: { id?: string } } | null)?.main?.id
    } else {
      const { getActiveCode } = await import("../services/jig-store.js")
      const active = getActiveCode(target)
      if (!active) {
        console.error(`No active code for ${target} on this machine, and no file named ${target}.`)
        return 1
      }
      code = active
      const { getMainModel } = await import("../config/models.js")
      defaultModel = getMainModel()
    }
  }

  const flow = analyzeJigFlow(code)
  if (args.includes("--json")) {
    console.log(JSON.stringify(flow, null, 2))
    return 0
  }
  const width = Math.min(Math.max(process.stdout.columns ?? 80, 60), 100)
  process.stdout.write(renderFlow(flow, { level, width, defaultModel }))
  return 0
}

/**
 * Auto-upgrade — detects legacy jigs (no block-scoped ctx.step calls)
 * and rewrites them using the agent on server startup.
 */
import { readFileSync } from "fs"
import { JIGS_DIR } from "../config/paths.js"
import { discoverJigs } from "../discover.js"
import { resolveJigPath } from "../domain/jig-source.js"
import { parseStepsFromSource } from "../derive-steps.js"

function isLegacyJig(code: string): boolean {
  // Has a handler but no block-scoped ctx.step() calls
  return /export\s+default/.test(code) && parseStepsFromSource(code).length === 0
}

/**
 * Find legacy jigs that need upgrading to declarative ctx.step() syntax.
 * Returns jig IDs that should be rewritten.
 */
export function findLegacyJigs(): string[] {
  const jigs = discoverJigs(JIGS_DIR)
  const legacy: string[] = []

  for (const jigId of jigs.keys()) {
    try {
      const code = readFileSync(resolveJigPath(jigId), "utf-8")
      if (isLegacyJig(code)) legacy.push(jigId)
    } catch {}
  }

  return legacy
}

/**
 * Auto-upgrade legacy jigs via the agent service.
 * Runs on startup — fires agent sessions to rewrite each legacy jig.
 */
export async function upgradeLegacyJigs(): Promise<void> {
  const legacy = findLegacyJigs()
  if (legacy.length === 0) return

  console.log(`[upgrade] found ${legacy.length} legacy jig(s): ${legacy.join(", ")}`)

  // Dynamic import to avoid circular deps with server.ts
  const { startAgentSession } = await import("../services/agent-service.js")

  for (const jigId of legacy) {
    try {
      console.log(`[upgrade] upgrading ${jigId}...`)
      await startAgentSession({
        instruction: `Upgrade this jig to use declarative ctx.step("label", [tools], async () => {...}) syntax. Wrap each logical group of tool calls in a ctx.step() block with a human-readable label. Keep the same behavior — just restructure the code to use block-scoped steps.`,
        jigId,
      })
      // Agent runs async in background — don't await completion
    } catch (e: any) {
      console.error(`[upgrade] failed to start upgrade for ${jigId}:`, e?.message ?? e)
    }
  }
}

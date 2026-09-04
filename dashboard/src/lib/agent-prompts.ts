/**
 * Ready-to-paste prompts for the coding agent (Claude Code, Codex) working in a
 * checkout paired to this instance. Pure: callers pass `window.location.origin`
 * in as `origin` so these stay usable outside a component.
 */

const PAIRING_HINT = "If the CLI is not paired yet, the Setup page generates the pairing command."

function editTail(jigId: string, action: string) {
  return `Pull it with \`bun run jig edit ${jigId} --out=${jigId}.ts\`, read SKILL.md, ${action}, push it with \`bun run jig edit ${jigId} --file=${jigId}.ts\`, then run \`bun run jig run ${jigId} --dry-run\`. ${PAIRING_HINT}`
}

export function changeJigPrompt({ origin, jigId }: { origin: string; jigId: string }) {
  return `In my Jig checkout paired to ${origin}, change the jig "${jigId}": <describe the change>. ${editTail(jigId, "make the change")}`
}

export function fixJigPrompt({ origin, jigId, step, error }: { origin: string; jigId: string; step: string; error: string }) {
  return `In my Jig checkout paired to ${origin}, the jig "${jigId}" failed at step "${step}" with: ${error.trim()}. ${editTail(jigId, "fix it")}`
}

/** Placeholders by default; pass `id` and `description` for a prompt the agent can run as-is. */
export function newJigPrompt({ origin, id = "<id>", description = "<what it should do>" }: { origin: string; id?: string; description?: string }) {
  return `In my Jig checkout paired to ${origin}, create a jig "${id}": ${description}. Run \`bun run jig types\`, read SKILL.md, write ${id}.ts, push it with \`bun run jig edit ${id} --file=${id}.ts\`, then run \`bun run jig run ${id} --dry-run\`. ${PAIRING_HINT}`
}

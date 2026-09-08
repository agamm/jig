/**
 * Ready-to-paste prompts for the coding agent (Claude Code, Codex) working in a
 * checkout paired to this instance. Pure: callers pass `window.location.origin`
 * in as `origin` so these stay usable outside a component.
 */

const PAIRING_HINT = "If the CLI is not paired yet, the Setup page generates the pairing command."

function editTail(jigId: string, action: string) {
  return `Pull it with \`bun run jig edit ${jigId} --out=${jigId}.ts\`, read SKILL.md, ${action}, push it with \`bun run jig edit ${jigId} --file=${jigId}.ts\` (it goes live when the instance's check is clean), then run \`bun run jig run ${jigId} --dry-run\` and fix and push again if the output is not right. ${PAIRING_HINT}`
}

export function changeJigPrompt({ origin, jigId }: { origin: string; jigId: string }) {
  return `In my Jig checkout paired to ${origin}, change the jig "${jigId}": <describe the change>. ${editTail(jigId, "make the change")}`
}

export function fixJigPrompt({ origin, jigId, step, error }: { origin: string; jigId: string; step: string; error: string }) {
  return `In my Jig checkout paired to ${origin}, the jig "${jigId}" failed at step "${step}" with: ${error.trim()}. ${editTail(jigId, "fix it")}`
}

/** Asks the agent to pin down the open questions (what, when, content, sources) before it writes anything. */
export const CLARIFY_FIRST =
  "Before writing any code, interview me with your question tool, one question at a time with a recommended answer, until you know what it should do, when it should run, what to include, and where the data comes from. Summarize the plan in a few lines and wait for my go-ahead."

/** Placeholders by default; pass `id` and `description` for a prompt the agent can run as-is. */
export function newJigPrompt({ origin, id = "<id>", description = "<what it should do>" }: { origin: string; id?: string; description?: string }) {
  return `In my Jig checkout paired to ${origin}, create a jig "${id}": ${description}. ${CLARIFY_FIRST} Then run \`bun run jig types\`, read SKILL.md, write ${id}.ts, push it with \`bun run jig edit ${id} --file=${id}.ts\` (it goes live when the instance's check is clean), then run \`bun run jig run ${id} --dry-run\` and fix and push again if the output is not right. ${PAIRING_HINT}`
}

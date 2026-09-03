/**
 * Drive an authoring-agent session over HTTP and render it to a terminal.
 *
 * Shared by `jig new` / `jig edit` (local server) and `jig debug new` (a
 * deployed instance, with a paired session cookie). The two differ only in base
 * URL and headers, and keeping one loop means a hosted instance cannot quietly
 * grow a different authoring experience from a local one.
 */

export interface AgentSessionOptions {
  /** Instance base URL, no trailing slash. */
  base: string
  /** Auth headers. Empty for a local instance, a session cookie for a remote. */
  headers?: Record<string, string>
  instruction: string
  /** Set to edit an existing jig instead of creating one. */
  jigId?: string
  /** How long to wait for the agent before giving up. */
  timeoutMs?: number
}

const POLL_MS = 1000

/** Returns the jig id the agent produced, or null when it finished without one. */
export async function runAgentSession(options: AgentSessionOptions): Promise<string | null> {
  const { base, headers = {}, instruction, jigId } = options
  const deadline = Date.now() + (options.timeoutMs ?? 300 * POLL_MS)

  const startRes = await fetch(`${base}/api/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify({ instruction, jigId }),
  })
  if (!startRes.ok) {
    const err = (await startRes.json().catch(() => ({}))) as { error?: string }
    throw new Error(err.error ?? `Failed to start the authoring agent (HTTP ${startRes.status})`)
  }

  const { sessionId } = (await startRes.json()) as { sessionId: string }
  let eventIndex = 0

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, POLL_MS))

    const res = await fetch(`${base}/api/agent/${sessionId}?since=${eventIndex}`, { headers })
    if (!res.ok) continue
    const data = (await res.json()) as {
      events?: { type: string; tool?: string; status?: string; args?: Record<string, unknown>; result?: string; content?: string }[]
      status?: string
      jigId?: string
      error?: string
    }

    for (const event of data.events ?? []) {
      if (event.type === "tool-call") {
        const icon = event.status === "done" ? "✓" : event.status === "error" ? "✗" : "…"
        const args = Object.entries(event.args ?? {})
          .filter(([k]) => k !== "code")
          .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 50) : JSON.stringify(v)}`)
          .join(", ")
        console.log(`  ${icon} ${event.tool}${args ? ` (${args})` : ""}`)
        if (event.tool === "check_jig" && event.result && event.result !== "ok") {
          console.log(`    ${event.result.replace(/\n/g, "\n    ")}`)
        }
      } else if (event.type === "text" && event.content) {
        console.log(`\n${event.content}`)
      }
    }
    eventIndex += data.events?.length ?? 0

    if (data.status === "done") return data.jigId ?? null
    if (data.status === "error") throw new Error(data.error ?? "The authoring agent failed.")
  }

  throw new Error("The authoring agent timed out.")
}

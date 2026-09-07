/**
 * Classify a run failure from its error text, with the remedy spelled out.
 *
 * Runs store only the error string, so this is string matching by design and
 * the patterns come from the messages this codebase and its providers really
 * emit (see failure-class.test.ts). Order matters: the specific external
 * causes come first, "code" is the fallback that means nothing external was
 * recognised and the jig's own code is the place to look. The same verdict is
 * quoted by the failure email, the audit and `jig debug failures`, so a coding
 * agent and the owner read the same next step.
 */
import type { FailureCause } from "../../shared/api.js"

export interface FailureVerdict {
  cause: FailureCause
  /** One line, imperative, with the exact command where one exists. */
  remedy: string
}

export interface FailureContext {
  jigId: string
  /** Connections the failing step (or the jig) uses; the first is the reconnect default. */
  connections?: string[]
}

const RULES: { cause: FailureCause; test: RegExp }[] = [
  { cause: "composio-spill", test: /spilled to \/mnt\/files|too large to return inline|ComposioSpillError/i },
  { cause: "locked", test: /jig is locked|LockedError/i },
  { cause: "missing-connection", test: /Connection required: [\w-]+/ },
  {
    cause: "auth",
    test: /\b40[13]\b|unauthori[sz]ed|forbidden|invalid_grant|invalid_token|invalid_client|access_denied|authorization expired|revoked|invalid refresh token|token (?:rejected|expired|invalid)|auth-required|reconnect it/i,
  },
  { cause: "credits", test: /\b402\b|insufficient credits|payment required/i },
  { cause: "rate-limit", test: /\b429\b|rate.?limit|too many requests|quota/i },
  {
    cause: "provider",
    test: /\b50[0-9]\b|bad gateway|service unavailable|gateway time.?out|ECONNRESET|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|fetch failed|socket hang up|SSE error|unreachable after/i,
  },
  { cause: "timeout", test: /timed out|timeout/i },
]

/** The cause in plain words, for the failure email. */
export function describeCause(cause: FailureCause): string {
  switch (cause) {
    case "composio-spill": return "Composio result too large to return"
    case "locked": return "the instance was locked"
    case "missing-connection": return "a connection is not set up"
    case "auth": return "authorization expired or revoked"
    case "credits": return "OpenRouter out of credit"
    case "rate-limit": return "rate limited"
    case "provider": return "upstream service failure"
    case "timeout": return "timed out"
    case "code": return "the jig's code (nothing external recognised)"
  }
}

export function classifyFailure(error: string | null | undefined, ctx: FailureContext): FailureVerdict {
  const text = (error ?? "").trim()
  const cause = RULES.find((r) => r.test.test(text))?.cause ?? "code"
  return { cause, remedy: remedyFor(cause, text, ctx) }
}

function remedyFor(cause: FailureCause, text: string, ctx: FailureContext): string {
  const id = ctx.jigId
  switch (cause) {
    case "composio-spill":
      return "Composio capped the result and spilled the rest where a run cannot read it. Connect the service's own MCP server (bun run jig connect <service>) and import that instead of composio, or ask for less (max_results, drop verbose/include_payload, paginate)."
    case "locked":
      return "The instance was locked, so credentials were unreadable: bun run jig unlock <handle>. With JIG_DATA_KEY set on the service this stops recurring."
    case "missing-connection": {
      const name = /Connection required: ([\w-]+)/.exec(text)?.[1] ?? "<server>"
      return `The jig imports a connection that is not set up: bun run jig connect ${name}`
    }
    case "auth":
      return `Authorization expired or was revoked. Re-authorize it: bun run jig connect ${serverFrom(text, ctx)}, then bun run jig run ${id} --dry-run`
    case "credits":
      return "OpenRouter has no credit left. Add some at https://openrouter.ai/settings/credits, then rerun."
    case "rate-limit":
      return "Rate limited or over quota. Rerun later; if it recurs, do less per run or spread the schedule."
    case "provider":
      return `The upstream service failed (5xx or network). Rerun later; if it persists: bun run jig debug connections ${ctx.connections?.[0] ?? ""}`.trimEnd()
    case "timeout":
      return "Ran past its timeout. Raise runTimeoutMs or toolTimeoutMs in the jig options, or do less per run."
    case "code":
      return `bun run jig edit ${id} --out=${id}.ts   (fix, then --file=, then run --dry-run)`
  }
}

/** The server an auth error is about: named in the message when the MCP client wrote it, else the step's first connection. */
function serverFrom(text: string, ctx: FailureContext): string {
  const named = /^([\w-]+): authorization/i.exec(text)?.[1] ?? /"([\w-]+)" (?:MCP server|connection)/.exec(text)?.[1]
  return named ?? ctx.connections?.[0] ?? "<server>"
}

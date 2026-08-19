/**
 * Parsing for `jig debug eval --args=<json>`.
 *
 * Split out from the command so the failure modes are testable without a
 * remote: a hand-typed JSON blob on a shell command line is the part most
 * likely to be wrong, and the raw SyntaxError ("Unexpected token }") names
 * neither the flag nor what it should have held.
 */

export type ParsedToolArgs =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string }

export function parseToolArgs(raw: string | undefined): ParsedToolArgs {
  if (raw === undefined) return { ok: true, value: {} }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e: any) {
    return { ok: false, error: `--args is not valid JSON: ${e?.message ?? e}. Quote it, e.g. --args='{"max_results":3}'` }
  }

  // MCP tool arguments are always a named map, so catch an array or scalar here
  // rather than forwarding it for the server to reject less clearly.
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, error: `--args must be a JSON object of tool arguments, got ${Array.isArray(parsed) ? "an array" : typeof parsed}.` }
  }
  return { ok: true, value: parsed as Record<string, unknown> }
}

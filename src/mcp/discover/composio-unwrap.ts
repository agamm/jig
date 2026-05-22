/**
 * Composio `COMPOSIO_MULTI_EXECUTE_TOOL` response unwrapper.
 *
 * Composio's meta-tool returns a wrapped envelope. For small results it puts
 * the real payload at `response.data`. For large results (≳20k tokens) it
 * spills the full data to a sandbox file at `remote_file_info.file_path`
 * and returns only a truncated `response.data_preview` inline — including
 * sentinel STRINGS like `"...18 more items"` mixed into arrays in place of
 * the real entries.
 *
 * If a caller unwraps `data_preview` directly (the previous behavior),
 * downstream logic silently consumes garbage — for the daily-email-reply-
 * digest jig the LLM saw 2 emails + 1 sentinel string instead of the full
 * 20, every run, for days, with no error surfaced anywhere.
 *
 * **We do NOT attempt to recover the spilled file.** We tested it: each
 * follow-up `COMPOSIO_REMOTE_BASH_TOOL` call runs in a fresh sandbox
 * (distinct `sandbox_id_suffix`) where the file does not exist, regardless
 * of `sync_response_to_workbench`. The cross-sandbox recovery path
 * described in Composio's own `remote_file_info.instructions` only works
 * within a single multi-execute call, not across MCP tool calls.
 *
 * So we throw `ComposioSpillError` loudly. Callers must either reduce
 * args (max_results / verbose / include_payload) or paginate via
 * `nextPageToken` so the inline response stays under the spill threshold.
 */

export type CallToolFn = (toolName: string, args: Record<string, unknown>) => Promise<any>

export class ComposioSpillError extends Error {
  filePath: string
  constructor(filePath: string, tokenEstimate?: number) {
    const sizeNote = typeof tokenEstimate === "number" ? ` (~${tokenEstimate} tokens)` : ""
    super(
      `composio: response was too large to return inline${sizeNote} and was spilled to ${filePath}, ` +
      `which is unreachable from the MCP session. Reduce max_results, drop verbose / include_payload, ` +
      `or paginate via nextPageToken so the inline response stays under ~10k tokens.`,
    )
    this.name = "ComposioSpillError"
    this.filePath = filePath
  }
}

const SPILL_PATH_RE = /^\/mnt\/files\/[A-Za-z0-9_./-]+\.json$/

export async function unwrapComposioResult(raw: any, _callTool?: CallToolFn): Promise<any> {
  const top = raw?.data ?? {}
  const execResult = top?.results?.[0] ?? {}
  const response = execResult?.response

  // Spill marker present anywhere on the envelope → throw. The
  // `data_preview` field that sits next to the marker is not the data; it's
  // a truncated sample with literal sentinel strings ("...N more items")
  // poisoning every array, and returning it would mask data loss.
  const outerSpill = top?.remote_file_info
  const innerSpill = response?.remote_file_info
  const outerPath = pickSpillPath(outerSpill)
  const innerPath = pickSpillPath(innerSpill)
  if (outerPath) {
    const tokens = typeof outerSpill?.tokens === "number" ? outerSpill.tokens : parseTokensFromMessage(outerSpill?.message)
    throw new ComposioSpillError(outerPath, tokens)
  }
  if (innerPath) {
    const tokens = typeof innerSpill?.tokens === "number" ? innerSpill.tokens : parseTokensFromMessage(innerSpill?.message)
    throw new ComposioSpillError(innerPath, tokens)
  }

  if (response?.data !== undefined) return response.data
  if (response?.data_preview !== undefined) return response.data_preview
  if (response !== undefined) return response
  return raw
}

function pickSpillPath(info: any): string | null {
  const p = info?.file_path
  if (typeof p !== "string") return null
  if (!SPILL_PATH_RE.test(p)) return null
  return p
}

function parseTokensFromMessage(msg: unknown): number | undefined {
  if (typeof msg !== "string") return undefined
  const m = msg.match(/\((\d+)\s*tokens\)/i)
  return m ? Number(m[1]) : undefined
}

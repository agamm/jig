/**
 * Composio `COMPOSIO_MULTI_EXECUTE_TOOL` response unwrapper.
 *
 * Composio's meta-tool returns a wrapped envelope. For small results it puts
 * the real payload at `response.data`. For large results it spills the full
 * data to a sandbox file at `remote_file_info.file_path` and returns only a
 * truncated `response.data_preview` inline — including sentinel STRINGS like
 * `"...18 more items"` mixed into arrays in place of the real entries.
 *
 * If a caller unwraps `data_preview` directly (the previous behavior), they
 * silently feed those sentinel strings to their downstream logic — for the
 * daily-email-reply-digest jig this meant the LLM saw 2 emails + 1 garbage
 * row instead of the full 20, every run, for days, with no error.
 *
 * This module fixes that by:
 *   1. Detecting `remote_file_info.file_path` in the multi-execute response.
 *   2. Issuing a follow-up `COMPOSIO_REMOTE_BASH_TOOL` to `cat` the file
 *      (the sandbox is session-scoped and the file persists for the life
 *      of the MCP connection).
 *   3. Returning the real `results[0].response.data` from the file contents.
 *   4. Throwing a typed `ComposioSpillError` if the fetch fails — so jigs
 *      fail loud instead of silently consuming truncated data.
 */

export type CallToolFn = (toolName: string, args: Record<string, unknown>) => Promise<any>

export class ComposioSpillError extends Error {
  filePath: string
  constructor(filePath: string, detail: string) {
    super(
      `composio: response was too large to return inline (spilled to ${filePath}) and recovery failed: ${detail}. ` +
      `Reduce max_results / verbose / include_payload, or paginate via nextPageToken.`,
    )
    this.name = "ComposioSpillError"
    this.filePath = filePath
  }
}

const SPILL_PATH_RE = /^\/mnt\/files\/[A-Za-z0-9_./-]+\.json$/

export async function unwrapComposioResult(raw: any, callTool: CallToolFn): Promise<any> {
  const top = raw?.data ?? {}
  const execResult = top?.results?.[0] ?? {}
  const response = execResult?.response

  // Multi-execute-level spill: the per-tool response objects are themselves
  // truncated; the real data lives in the sandbox file.
  const outerSpillPath = pickSpillPath(top?.remote_file_info ?? response?.remote_file_info)
  if (outerSpillPath) {
    const fileData = await fetchSpilledData(outerSpillPath, callTool)
    const restored = fileData?.results?.[0]?.response
    if (restored?.data !== undefined) return restored.data
    if (restored !== undefined) return restored
    return fileData
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

async function fetchSpilledData(filePath: string, callTool: CallToolFn): Promise<any> {
  let bashRaw: any
  try {
    bashRaw = await callTool("COMPOSIO_REMOTE_BASH_TOOL", { command: `cat ${filePath}` })
  } catch (err: any) {
    throw new ComposioSpillError(filePath, `bash fetch threw: ${err?.message ?? err}`)
  }
  const stdout: unknown = bashRaw?.data?.stdout ?? bashRaw?.stdout
  if (typeof stdout !== "string" || stdout.length === 0) {
    throw new ComposioSpillError(filePath, "bash returned empty stdout (likely also truncated)")
  }
  if (bashRaw?.data?.remote_file_info?.file_path || bashRaw?.remote_file_info?.file_path) {
    throw new ComposioSpillError(filePath, "bash response itself spilled — can't recursively recover")
  }
  try {
    return JSON.parse(stdout)
  } catch (err: any) {
    throw new ComposioSpillError(filePath, `spilled file is not valid JSON: ${err?.message ?? err}`)
  }
}

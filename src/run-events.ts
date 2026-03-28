/**
 * Events emitted during jig execution.
 * Both CLI and dashboard consume the same event stream.
 */
export type RunEvent =
  | { type: "step-start"; seq: number; label: string }
  | { type: "step-done"; seq: number; output: string; status: "success" | "fail" | "healed"; durationMs: number; error?: string }
  | { type: "tool"; completed: string[]; active: string[] }
  | { type: "output"; text: string }
  | { type: "done"; tools: string[]; output: string; durationMs: number }
  | { type: "error"; message: string }

import { AsyncLocalStorage } from "node:async_hooks"

/** Per-run context — lets tool wrappers and SDK functions find the active Context. */
export const runContext = new AsyncLocalStorage<Context>()

/** Step scan mode — runs handler to collect step labels without executing anything. */
export const stepScanContext = new AsyncLocalStorage<boolean>()

export function isStepScan(): boolean {
  return stepScanContext.getStore() ?? false
}

/** Truncate a label to max length (no ellipsis — humanize makes it readable). */
export function truncLabel(s: string, max = 60): string {
  const trimmed = s.trim()
  return trimmed.length > max ? trimmed.slice(0, max).trim() : trimmed
}

/**
 * Records step-level events during jig execution.
 * Implemented by the API server to write to SQLite.
 */
export interface RunRecorder {
  onStepStart(seq: number, label: string): void
  onStepDone(seq: number, output: string, status: "success" | "fail", durationMs: number, connections: string[], error?: string): void
  onOutput?(text: string): void
}

/**
 * Context object passed to every jig handler.
 * Provides access to params, output, and parallel execution.
 */
export class Context {
  private _output: string[] = []
  private _sink: (...args: any[]) => void = console.log
  private _recorder: RunRecorder | null = null
  private _stepSeq = 0
  private _stepStart = 0
  private _stepOutput: string[] = []
  private _stepConnections = new Set<string>()

  /** True while inside an agent() call — tool calls won't auto-create steps. */
  private _inAgent = false

  get inAgent() { return this._inAgent }
  enterAgent() { this._inAgent = true }
  leaveAgent() { this._inAgent = false }

  constructor(
    public readonly params: Record<string, string>,
    private allowedTools: string[]
  ) {}

  /** Attach a recorder for step-level tracking (used by API server). */
  setRecorder(recorder: RunRecorder) { this._recorder = recorder }

  /** Mark the start of a named step. */
  step(label: string) {
    // Finish previous step if one was active.
    if (this._stepSeq > 0) {
      this.finalize()
    }
    this._stepSeq++
    this._stepStart = Date.now()
    this._stepOutput = []
    this._stepConnections = new Set()
    this._recorder?.onStepStart(this._stepSeq, label)
  }

  /** Record a connection used in the current step. */
  addConnection(name: string) {
    this._stepConnections.add(name)
  }

  /** Write output. Presentation layer decides how to render. */
  output(...args: any[]) {
    const line = args.map(String).join(" ")
    this._output.push(line)
    this._stepOutput.push(line)
    this._sink(...args)
    this._recorder?.onOutput?.(line)
  }

  /** @deprecated Use ctx.output() instead. */
  log(...args: any[]) { this.output(...args) }

  /** Get all captured output. Used by dry-run and dashboard. */
  getOutput(): string[] { return this._output }

  /** Replace the output sink (default: console.log). */
  setSink(sink: (...args: any[]) => void) { this._sink = sink }

  /** Finish the last step (called at end of handler or on error). */
  finalize(error?: unknown) {
    if (this._stepSeq > 0) {
      const status = error ? "fail" : "success"
      const errMsg = error instanceof Error ? error.message : error ? String(error) : undefined
      const durationMs = Date.now() - this._stepStart
      const output = this._stepOutput.join("\n")
      this._recorder?.onStepDone(this._stepSeq, output, status, durationMs, Array.from(this._stepConnections), errMsg)
    }
  }

  /**
   * Execute multiple promises concurrently.
   * Syntactic sugar over Promise.all with proper typing.
   */
  async parallel<T extends readonly unknown[]>(
    ...fns: { [K in keyof T]: Promise<T[K]> }
  ): Promise<T> {
    return Promise.all(fns) as Promise<T>
  }
}

/**
 * Records step-level events during jig execution.
 * Implemented by the API server to write to SQLite.
 */
export interface RunRecorder {
  onStepStart(seq: number, label: string): void
  onStepDone(seq: number, output: string, status: "success" | "fail" | "healed", durationMs: number, error?: string): void
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

  constructor(
    public readonly params: Record<string, string>,
    private allowedTools: string[]
  ) {}

  /** Attach a recorder for step-level tracking (used by API server). */
  setRecorder(recorder: RunRecorder) { this._recorder = recorder }

  /** Mark the start of a named step. */
  step(label: string) {
    // Finish previous step if one was active.
    // No double-emit: finalize() emits for current _stepSeq, then _stepSeq++
    // creates a new slot. End-of-handler finalize() emits for the final step only.
    if (this._stepSeq > 0) {
      this.finalize()
    }
    this._stepSeq++
    this._stepStart = Date.now()
    this._stepOutput = []
    this._recorder?.onStepStart(this._stepSeq, label)
  }

  /** Write output. Presentation layer decides how to render. */
  log(...args: any[]) {
    const line = args.map(String).join(" ")
    this._output.push(line)
    this._stepOutput.push(line)
    this._sink(...args)
    this._recorder?.onOutput?.(line)
  }

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
      this._recorder?.onStepDone(this._stepSeq, output, status, durationMs, errMsg)
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

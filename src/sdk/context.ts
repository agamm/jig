/**
 * Context object passed to every jig handler.
 * Provides access to params, output, and parallel execution.
 */
export class Context {
  private _output: string[] = []
  private _sink: (...args: any[]) => void = console.log

  constructor(
    public readonly params: Record<string, string>,
    private allowedTools: string[]
  ) {}

  /** Write output. Presentation layer decides how to render. */
  log(...args: any[]) {
    const line = args.map(String).join(" ")
    this._output.push(line)
    this._sink(...args)
  }

  /** Get all captured output. Used by dry-run and dashboard. */
  getOutput(): string[] { return this._output }

  /** Replace the output sink (default: console.log). */
  setSink(sink: (...args: any[]) => void) { this._sink = sink }

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

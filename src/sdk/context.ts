/**
 * Context object passed to every jig handler.
 * Provides access to params and parallel execution.
 */
export class Context {
  constructor(
    public readonly params: Record<string, string>,
    private allowedTools: string[]
  ) {}

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

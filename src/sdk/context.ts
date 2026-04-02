import { AsyncLocalStorage } from "node:async_hooks"
import type { JigTool } from "./jig.js"

/** Thrown by ctx.skip() to short-circuit a handler. Run is NOT persisted. */
export class SkipError extends Error {
  constructor(reason?: string) {
    super(reason ?? "skipped")
    this.name = "SkipError"
  }
}

/** Per-run context — lets tool wrappers and SDK functions find the active Context. */
export const runContext = new AsyncLocalStorage<Context>()

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

type StepTool = {
  connection: string
  name: string
  readOnly: boolean
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
  private _stepTools = new Map<string, StepTool>()
  private _stepFinalized = true

  /** True while inside an agent() call — tool calls won't auto-create steps. */
  private _inAgent = false

  /** Tool names allowed in the current block-scoped step (empty = no active scoped step). */
  private _currentStepToolNames: string[] = []

  /** Label of the current block-scoped step (null between steps). */
  private _currentStepLabel: string | null = null

  get inAgent() { return this._inAgent }
  enterAgent() { this._inAgent = true }
  leaveAgent() { this._inAgent = false }

  get currentStepLabel(): string | null { return this._currentStepLabel }
  get currentStepToolNames(): string[] { return this._currentStepToolNames }

  /** Returns true only if a step is active and the tool is in its allowed list. */
  isToolAllowedInCurrentStep(toolName: string): boolean {
    if (this._currentStepLabel === null) return false
    return this._currentStepToolNames.includes(toolName)
  }

  constructor(
    public readonly params: Record<string, string>,
    private allowedTools: string[]
  ) {}

  /** Attach a recorder for step-level tracking (used by API server). */
  setRecorder(recorder: RunRecorder) { this._recorder = recorder }

  /** Block-scoped step: sets allowed tools, runs fn, clears tools on exit. */
  async step<T>(label: string, tools: JigTool[], fn: () => Promise<T>): Promise<T> {
    // Finish previous step if one was active.
    if (this._stepSeq > 0 && !this._stepFinalized) {
      this.finalize()
    }
    this._stepSeq++
    this._stepFinalized = false
    this._stepStart = Date.now()
    this._stepOutput = []
    this._stepConnections = new Set()
    this._stepTools = new Map()
    this._currentStepLabel = label
    this._currentStepToolNames = tools.map(t => t._toolName)
    for (const tool of tools) {
      this.addTool(tool._serverName, tool._toolName, tool._readOnly ?? true)
    }
    this._recorder?.onStepStart(this._stepSeq, label)

    try {
      const result = await fn()
      this.finalize()
      return result
    } catch (e) {
      this.finalize(e)
      throw e
    } finally {
      this._currentStepLabel = null
      this._currentStepToolNames = []
    }
  }

  /** Record a connection used in the current step. */
  addConnection(name: string) {
    this._stepConnections.add(name)
  }

  addTool(connection: string, name: string, readOnly: boolean) {
    this._stepConnections.add(connection)
    this._stepTools.set(`${connection}:${name}`, { connection, name, readOnly })
  }

  getStepTools(): StepTool[] {
    return Array.from(this._stepTools.values())
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
    if (this._stepSeq > 0 && !this._stepFinalized) {
      this._stepFinalized = true
      const status = error ? "fail" : "success"
      const errMsg = error instanceof Error ? error.message : error ? String(error) : undefined
      const durationMs = Date.now() - this._stepStart
      const output = this._stepOutput.join("\n")
      this._recorder?.onStepDone(this._stepSeq, output, status, durationMs, Array.from(this._stepConnections), errMsg)
    }
  }

  /** Short-circuit the handler. The run is NOT persisted or shown in dashboard. */
  skip(reason?: string): never {
    throw new SkipError(reason)
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

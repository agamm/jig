import { AsyncLocalStorage } from "node:async_hooks"
import type { JigTool } from "./jig.js"
import { isCancellationError, USER_CANCELLED_MESSAGE } from "../run-cancel.js"
import { createJigMemory, type JigMemory } from "./memory.js"
import { createJigReminders, type JigReminders, type PendingReminder } from "./reminders.js"

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

  /** Base model for this run (jig code or dashboard override). null = use global default. */
  private _baseModel: string | null = null

  /** Stack of step-scoped model overrides — top of stack wins inside a step. */
  private _stepModelStack: (string | null)[] = []

  /** Dashboard-set per-step model overrides keyed by step seq (1-indexed). */
  private _stepModelOverrides: Record<string, string> = {}

  get inAgent() { return this._inAgent }
  enterAgent() { this._inAgent = true }
  leaveAgent() { this._inAgent = false }

  get currentStepLabel(): string | null { return this._currentStepLabel }
  get currentStepToolNames(): string[] { return this._currentStepToolNames }

  /**
   * Current model to use for llm()/agent() calls with no explicit `model` option.
   * Returns null when nothing is set; callers fall back to the global default.
   */
  get currentModel(): string | null {
    return this._stepModelStack.length > 0
      ? (this._stepModelStack[this._stepModelStack.length - 1] ?? this._baseModel)
      : this._baseModel
  }

  /** Set the run-level default model (called once at run start from sdk/jig.ts). */
  setBaseModel(model: string | null): void {
    this._baseModel = model ?? null
  }

  /** Install dashboard-set per-step overrides. Called once at run start. */
  setStepModelOverrides(map: Record<string, string>): void {
    this._stepModelOverrides = { ...map }
  }

  /** Returns true only if a step is active and the tool is in its allowed list. */
  isToolAllowedInCurrentStep(toolName: string): boolean {
    if (this._currentStepLabel === null) return false
    return this._currentStepToolNames.includes(toolName)
  }

  private readonly _signal?: AbortSignal
  private readonly _toolTimeoutMs?: number | null
  private readonly _jigId?: string

  /**
   * Persistent per-jig store. Survives across runs, scoped so one jig can
   * neither read nor overwrite another's keys. Values round-trip as JSON.
   *
   *   await ctx.memory.set("todo:42", { title: "Renew passport", dueAt })
   *   const open = await ctx.memory.list("todo:")
   *
   * Writes no-op under a dry run; reads return the real stored data so the
   * preview reflects actual state.
   */
  public readonly memory: JigMemory

  private readonly _reminders: JigReminders

  constructor(
    public readonly params: Record<string, unknown> = {},
    options: { signal?: AbortSignal; toolTimeoutMs?: number | null; jigId?: string } = {},
  ) {
    this._signal = options.signal
    this._toolTimeoutMs = options.toolTimeoutMs
    this._jigId = options.jigId
    // Dry-run notices go through output() so they land in the run preview
    // alongside the tool calls that were likewise not performed.
    const note = (message: string) => this.output(message)
    this.memory = createJigMemory(options.jigId, note)
    this._reminders = createJigReminders(options.jigId, note)
  }

  /**
   * Wake this jig at `at`, carrying `payload`. The scheduler starts the run and
   * puts every payload that came due in `ctx.params.reminders` (an array, more
   * than one can come due on the same tick).
   *
   *   await ctx.remind(dueAt, { todoKey: "todo:42" }, { key: "todo:42" })
   *
   * Passing `options.key` makes the call idempotent: it replaces that key's
   * pending reminder instead of stacking a second one. No-ops under a dry run.
   */
  async remind(at: Date | number | string, payload?: unknown, options?: { key?: string }): Promise<void> {
    return this._reminders.remind(at, payload, options)
  }

  /**
   * Run `fn` the first time this jig sees `key`, and never again.
   *
   *   for (const meeting of meetings) {
   *     await ctx.once(`coached:${meeting.id}`, async () => { ... })
   *   }
   *
   * This is what makes a polling jig safe. A jig on a 15-minute cron sees the
   * same meeting on every tick; without a record of what it already handled it
   * would act on each one repeatedly. A time window is the usual workaround,
   * but a window wide enough to survive a late tick is also wide enough to fire
   * twice, and some sources (Granola meetings, for one) do not expose an end
   * time to build a window from at all.
   *
   * The key is recorded BEFORE `fn` runs, so a crash midway costs one missed
   * item rather than repeating a side effect that already happened. If `fn`
   * throws, the key is released so the next run retries it.
   *
   * Returns true when `fn` ran, false when the key had already been seen.
   * During a dry run `fn` always runs and nothing is recorded.
   */
  async once(key: string, fn: () => Promise<unknown>): Promise<boolean> {
    const { isDryRun } = await import("./dryrun.js")
    if (isDryRun()) {
      this.output(`[dry-run] would run once for ${key}`)
      await fn()
      return true
    }
    if (await this.memory.get(key) !== null) return false
    // Claim first. Same reasoning as the reminder and calendar-fire ledgers:
    // claim-after would repeat the side effect on every tick until one run
    // happened to survive long enough to record it.
    await this.memory.set(key, { at: new Date().toISOString() })
    try {
      await fn()
      return true
    } catch (error) {
      // The work did not happen, so the claim must not stand.
      await this.memory.delete(key).catch(() => {})
      throw error
    }
  }

  /** Reminders scheduled but not yet fired, soonest first. */
  async reminders(): Promise<PendingReminder[]> {
    return this._reminders.reminders()
  }

  /** Cancel a pending reminder by key. True when one was actually cancelled. */
  async cancelReminder(key: string): Promise<boolean> {
    return this._reminders.cancelReminder(key)
  }

  get signal(): AbortSignal | undefined { return this._signal }

  /** Per-jig MCP tool-call timeout override (ms); null/undefined = global default. */
  get toolTimeoutMs(): number | null | undefined { return this._toolTimeoutMs }

  /** Attach a recorder for step-level tracking (used by API server). */
  setRecorder(recorder: RunRecorder) { this._recorder = recorder }

  /**
   * Block-scoped step: sets allowed tools, runs fn, clears tools on exit.
   *
   * Optional `options.model` overrides the default LLM model for the duration
   * of this step. Per-call options on llm()/agent() still win above it.
   */
  async step<T>(
    label: string,
    tools: JigTool<any, any>[],
    fn: () => Promise<T>,
    options?: { model?: string },
  ): Promise<T> {
    // Reject nested steps — they hide structure from the dashboard and break tool scoping.
    if (this._currentStepLabel !== null) {
      throw new Error(
        `ctx.step("${label}") called inside step "${this._currentStepLabel}". `
        + `Steps must be sequential at the top level of the handler — never nested. `
        + `Move this step out of the surrounding step's callback.`
      )
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

    // Precedence for this step's default model (high → low):
    //   per-call options on llm()/agent()  ← still wins above whatever we push
    //   dashboard step override (this._stepModelOverrides[seq])
    //   code-declared step option (options.model)
    //   jig-level base (already in _baseModel)
    // We resolve the step's pushed value once at entry; the per-call layer
    // is handled by llm()/agent() reading runContext.getStore()?.currentModel.
    const codeStepModel = typeof options?.model === "string" && options.model.trim().length > 0
      ? options.model.trim()
      : null
    const dashboardStepModel = this._stepModelOverrides[String(this._stepSeq)] ?? null
    const stepModel = dashboardStepModel ?? codeStepModel
    const pushedModel = stepModel !== null
    if (pushedModel) this._stepModelStack.push(stepModel)

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
      if (pushedModel) this._stepModelStack.pop()
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

  /**
   * Email the user (the configured AgentMail owner) a repliable message —
   * replying to it opens THIS jig's authoring agent (reply-to-edit). Use for
   * output meant for the user themselves (digests, briefings, things they may
   * want to revise). For one-way mail to other recipients, use an MCP email
   * tool (e.g. gmail_send) instead. Call inside a `ctx.step(...)`.
   *
   * Sends only to the owner (a reply from anyone else is rejected on inbound).
   * No-ops during dry-run. Throws if AgentMail isn't set up.
   */
  async email(opts: { subject: string; text?: string; html?: string }): Promise<{ threadId: string; messageId: string }> {
    // Dry-run first: a preview must never send, and must not fail just because
    // AgentMail isn't configured.
    const { isDryRun } = await import("./dryrun.js")
    if (isDryRun()) {
      this.output(`[dry-run] would email you: ${opts.subject}`)
      return { threadId: "dry-run", messageId: "dry-run" }
    }
    const { canSendAgentMail, getAgentMailSettings, sendAgentMailEmail } = await import("../services/agentmail.js")
    const owner = getAgentMailSettings().owner
    if (!canSendAgentMail() || !owner) {
      throw new Error("ctx.email needs AgentMail — connect an inbox in Settings → Notifications.")
    }
    // An email-triggered jig sends from its OWN inbox, so the user's reply lands
    // back there and is delivered to the jig as data (a to-do, a "snooze it")
    // rather than to its authoring agent as an instruction to rewrite the code.
    const { getJigInbox } = await import("../db.js")
    const ownInbox = this._jigId ? getJigInbox(this._jigId) : null
    // Reply-to-edit opens this jig's authoring agent, so the reply needs the same
    // spoof-resistant token as failure emails. Only mint one when we'll actually
    // map the thread (jig context present) AND replies mean "edit", a jig with
    // its own inbox routes replies to itself as data, where a token would only
    // add a reply-ref line to every message for no gain.
    const { mintReplyToken, subjectWithReplyToken, replyTokenFooter, replyTokenHtmlFooter } =
      await import("../services/reply-token.js")
    const token = this._jigId && !ownInbox ? mintReplyToken() : null
    // Send HTML by default. Jig bodies are usually LLM output, which is markdown,
    // and a text/plain part renders "**bold**" literally in the client. Derive
    // the HTML part from the text when the caller didn't supply its own, keeping
    // the original text as the plain-text alternative.
    const { looksHtml, markdownishToHtml } = await import("../text.js")
    const html =
      opts.html ??
      (opts.text != null && !looksHtml(opts.text) ? markdownishToHtml(opts.text) : undefined)
    const res = await sendAgentMailEmail({
      to: owner,
      subject: token ? subjectWithReplyToken(opts.subject, token) : opts.subject,
      text: token && opts.text != null ? `${opts.text}${replyTokenFooter(token)}` : opts.text,
      html: token && html != null ? `${html}${replyTokenHtmlFooter(token)}` : html,
      ...(ownInbox && { fromInboxId: ownInbox.inbox_id }),
    })
    // Map the thread to this jig so the user's reply routes to its authoring
    // agent. Skipped for a jig with its own inbox: replies there are routed by
    // inbox instead, and a thread row would send them to the authoring agent.
    if (this._jigId && !ownInbox) {
      const { recordEmailThread } = await import("../db.js")
      recordEmailThread(res.threadId, this._jigId, "auto", token)
    }
    return res
  }

  /** Get all captured output. Used by dry-run and dashboard. */
  getOutput(): string[] { return this._output }

  /** Replace the output sink (default: console.log). */
  setSink(sink: (...args: any[]) => void) { this._sink = sink }

  /** Finish the last step (called at end of handler or on error). */
  finalize(error?: unknown) {
    if (this._stepSeq > 0 && !this._stepFinalized) {
      this._stepFinalized = true
      const status = error ? "fail" : "success"
      const cancelled = isCancellationError(error)
      const errMsg = cancelled
        ? USER_CANCELLED_MESSAGE
        : error instanceof Error
        ? error.message
        : error
        ? String(error)
        : undefined
      const durationMs = Date.now() - this._stepStart
      let output = this._stepOutput.join("\n")
      if (cancelled) {
        output = output.trim()
          ? `${output}\n\n${USER_CANCELLED_MESSAGE}`
          : USER_CANCELLED_MESSAGE
      }
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

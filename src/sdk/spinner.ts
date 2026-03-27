/**
 * Jig spinner — mechanical clamping animation.
 *
 * Two jaws close in, lock on the workpiece, hold, release.
 * Fixed width — no line jumping.
 *
 * Tool chain shows execution order:
 *   [a] → [b]       = sequential (different rounds)
 *   [a, b]           = parallel (same round)
 *   [a, b] → [c]    = parallel batch, then sequential
 */

// Close in (3 frames), clamp + hold (3 frames ≈ 1s), snap open
const FRAMES = [
  "[>    <]",
  "[ >  < ]",
  "[  ><  ]",
  "[  ><  ]",
  "[  ><  ]",
  "[  ><  ]",
  "[>    <]",
]

type ToolBatch = string[]

/** Batch of tool names called in parallel */
export type ToolBatchInfo = string[]
/** Full chain of tool batches: sequential rounds of parallel calls */
export type ToolChain = ToolBatchInfo[]
export type ToolCallback = (chain: ToolChain, currentBatch: ToolBatchInfo) => void

export class Spinner {
  private interval?: Timer
  private start = Date.now()
  private frame = 0
  private label: string = ""
  private batches: ToolBatch[] = []
  private currentBatch: ToolBatch | null = null
  private _onTool: ToolCallback | null = null

  /** Set a callback that fires whenever a tool is called. Used by the API server for real-time progress. */
  setToolCallback(cb: ToolCallback | null) { this._onTool = cb }

  show(label: string) {
    if (!process.stderr.isTTY) return
    this.label = label
    this.start = Date.now()
    this.frame = 0
    this.batches = []
    this.currentBatch = null
    this.interval = setInterval(() => this.render(), 300)
  }

  /** Start a new batch of parallel tool calls */
  batch() {
    if (this.currentBatch && this.currentBatch.length > 0) {
      this.batches.push(this.currentBatch)
    }
    this.currentBatch = []
  }

  /** Add a tool to the current batch */
  tool(name: string) {
    const short = name.includes("__") ? name.split("__")[1] : name
    if (!this.currentBatch) this.currentBatch = []
    this.currentBatch.push(short)
    // Notify callback with full chain + current batch
    this._onTool?.([...this.batches, this.currentBatch], this.currentBatch)
    if (process.stderr.isTTY) this.render()
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval)
      this.interval = undefined
      // Flush last batch
      if (this.currentBatch && this.currentBatch.length > 0) {
        this.batches.push(this.currentBatch)
        this.currentBatch = null
      }
      process.stderr.write(`\r\x1b[K`)
    }
  }

  private formatChain(): string {
    const allBatches = [...this.batches]
    if (this.currentBatch && this.currentBatch.length > 0) {
      allBatches.push(this.currentBatch)
    }
    if (allBatches.length === 0) return ""

    const parts = allBatches.map((batch) =>
      batch.length === 1 ? `[${batch[0]}]` : `[${batch.join(", ")}]`
    )
    return ` ${parts.join(" → ")}`
  }

  private render() {
    const elapsed = ((Date.now() - this.start) / 1000).toFixed(1)
    const frame = FRAMES[this.frame % FRAMES.length]
    const chain = this.formatChain()

    const cols = process.stderr.columns ?? 80
    const base = `${frame} ${this.label} ${elapsed}s`
    let line = `${base}${chain}`

    if (line.length > cols - 2) {
      const maxChain = cols - base.length - 6
      if (maxChain > 10) {
        line = `${base} …${chain.slice(chain.length - maxChain)}`
      } else {
        line = base
      }
    }

    process.stderr.write(`\r\x1b[K\x1b[2m${line}\x1b[0m`)
    this.frame++
  }
}

export const spinner = new Spinner()

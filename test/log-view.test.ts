import { describe, expect, it } from "bun:test"
import {
  describeLog,
  filterGroups,
  groupRuns,
  isOperationalLog,
  parseFields,
  type LogGroup,
  type RunBlock,
} from "../dashboard/src/lib/log-view"
import type { ServerLogEntry } from "../shared/api"

let seq = 0
const T0 = 1_757_000_000_000
function entry(msg: string, level: ServerLogEntry["level"] = "info", offsetMs = 0): ServerLogEntry {
  seq += 1
  return { seq, ts: T0 + offsetMs, level, msg, payload: undefined }
}

function runsOf(groups: LogGroup[]): RunBlock[] {
  return groups.flatMap((g) => (g.type === "run" ? [g.run] : []))
}

describe("parseFields", () => {
  it("keeps spaces inside values and splits only at the next key", () => {
    const f = parseFields("jigId=weekly runId=12 seq=2 step=Draft the summary durationMs=210 error=boom: a=b happened")
    expect(f.step).toBe("Draft the summary")
    expect(f.durationMs).toBe("210")
    expect(f.error).toBe("boom: a=b happened")
    expect(f.runId).toBe("12")
  })
})

describe("describeLog", () => {
  it("reads the run started line, including dry runs", () => {
    const item = describeLog(entry("[run] weekly started (runId=-1788646589321, dryRun)"))
    expect(item.kind).toBe("run")
    expect(item.role).toBe("run-start")
    expect(item.jigId).toBe("weekly")
    expect(item.runId).toBe(-1788646589321)
    expect(item.dryRun).toBe(true)
    expect(item.title).toBe("Dry run started")
  })

  it("turns a failed step line into a failed step item with its label", () => {
    const item = describeLog(entry("[run.step] failed jigId=weekly runId=12 seq=2 step=Draft the summary durationMs=210 error=boom", "error"))
    expect(item.kind).toBe("step")
    expect(item.role).toBe("step-end")
    expect(item.seq).toBe(2)
    expect(item.failed).toBe(true)
    expect(item.title).toBe("Step 2 failed")
    expect(item.detail).toContain("Draft the summary")
    expect(item.detail).toContain("boom")
  })

  it("describes tool and llm lines with model and duration", () => {
    const tool = describeLog(entry("[mcp.tool] result tool=GMAIL_FETCH_EMAILS durationMs=1275"))
    expect(tool.kind).toBe("tool")
    expect(tool.title).toBe("Tool GMAIL_FETCH_EMAILS")
    expect(tool.detail).toBe("1.3s")
    const llm = describeLog(entry("[sdk.llm] request model=vendor/model-x mode=structured"))
    expect(llm.kind).toBe("llm")
    expect(llm.role).toBe("llm-request")
    expect(llm.detail).toBe("vendor/model-x · structured")
  })

  it("leaves unknown console lines readable as system entries", () => {
    const item = describeLog(entry("API error: boom", "error"))
    expect(item.kind).toBe("sys")
    expect(item.failed).toBe(true)
    expect(item.title).toBe("API error: boom")
  })
})

describe("groupRuns", () => {
  it("collects one run's lines into a block and hides lifecycle noise", () => {
    const items = [
      entry("[run] weekly started (runId=12)", "info", 0),
      entry("[runner] start runType=run jig=weekly jigId=weekly runId=12", "info", 1),
      entry("[run.step] start jigId=weekly runId=12 seq=1 step=Fetch", "info", 2),
      entry("[sdk.llm] request model=m mode=plain jigId=weekly runId=12", "info", 3),
      entry("[sdk.llm] response model=m mode=plain finishReason=stop jigId=weekly runId=12", "info", 4),
      entry("[run.step] done jigId=weekly runId=12 seq=1 step=Fetch durationMs=400", "info", 5),
      entry("[runner] done jig=weekly jigId=weekly runId=12 durationMs=940", "info", 6),
      entry("[run] weekly done in 950ms", "info", 7),
    ].map(describeLog)
    const groups = groupRuns(items, T0 + 10_000)
    expect(groups).toHaveLength(1)
    const [run] = runsOf(groups)
    expect(run.jigId).toBe("weekly")
    expect(run.runId).toBe(12)
    expect(run.status).toBe("ok")
    // The runner's own measurement closes the block; the later [run] line is bookkeeping.
    expect(run.durationMs).toBe(940)
    expect(run.counts).toEqual({ steps: 1, failedSteps: 0, llm: 1, tools: 0 })
    const visible = run.items.filter((i) => !i.plumbing).map((i) => i.title)
    expect(visible).toEqual(["LLM response", "Step 1 done"])
  })

  it("marks a scheduler run failed from the error line and keeps the failing step", () => {
    const items = [
      entry("[runner] start runType=run jig=daily jigId=daily runId=3", "info", 0),
      entry("[run.step] start jigId=daily runId=3 seq=1 step=Look up", "info", 1),
      entry("[run.step] failed jigId=daily runId=3 seq=1 step=Look up durationMs=80 error=gmail 401", "error", 2),
      entry("[runner] error jig=daily jigId=daily runId=3 durationMs=90 error=gmail 401", "error", 3),
      entry("[scheduler] daily error: gmail 401", "error", 4),
    ].map(describeLog)
    const [run] = runsOf(groupRuns(items, T0 + 10_000))
    expect(run.status).toBe("failed")
    expect(run.error).toBe("gmail 401")
    expect(run.counts.failedSteps).toBe(1)
    // The failing step explains the failure; the run-end rows would only repeat it.
    expect(run.items.filter((i) => !i.plumbing).map((i) => i.title)).toEqual(["Step 1 failed"])
  })

  it("keeps the run failure row when no step explains it", () => {
    const items = [
      entry("[run] daily started (runId=4)", "info", 0),
      entry("[runner] error jig=daily jigId=daily runId=4 durationMs=12 error=Cannot find module x", "error", 1),
      entry("[run] daily error: Cannot find module x", "error", 2),
    ].map(describeLog)
    const [run] = runsOf(groupRuns(items, T0 + 10_000))
    expect(run.status).toBe("failed")
    expect(run.items.filter((i) => !i.plumbing).map((i) => i.title)).toEqual(["Runner failed"])
  })

  it("attaches anonymous run-scoped lines only when exactly one run is open", () => {
    const single = [
      entry("[run] a started (runId=1)", "info", 0),
      entry("[mcp.tool] call tool=X", "info", 1),
      entry("[mcp.tool] result tool=X durationMs=5", "info", 2),
      entry("[run] a done in 10ms", "info", 3),
    ].map(describeLog)
    const one = groupRuns(single, T0 + 10_000)
    expect(one).toHaveLength(1)
    expect(runsOf(one)[0].counts.tools).toBe(1)

    const two = [
      entry("[run] a started (runId=1)", "info", 0),
      entry("[run] b started (runId=2)", "info", 1),
      entry("[mcp.tool] call tool=X", "info", 2),
    ].map(describeLog)
    const groups = groupRuns(two, T0 + 10_000)
    expect(groups.map((g) => g.type)).toEqual(["run", "run", "entry"])
  })

  it("reports a run that never finished as running, then unknown once stale", () => {
    const items = [entry("[run] a started (runId=1)", "info", 0), entry("[run.step] start jigId=a runId=1 seq=1 step=Go", "info", 1)].map(describeLog)
    expect(runsOf(groupRuns(items, T0 + 60_000))[0].status).toBe("running")
    expect(runsOf(groupRuns(items, T0 + 60 * 60_000))[0].status).toBe("unknown")
  })

  it("closes a stale open run when the same jig starts again", () => {
    const items = [
      entry("[run] a started (runId=1)", "info", 0),
      entry("[run] a started (runId=2)", "info", 1000),
      entry("[run] a done in 5ms", "info", 1005),
    ].map(describeLog)
    const runs = runsOf(groupRuns(items, T0 + 10_000))
    expect(runs.map((r) => [r.runId, r.status])).toEqual([[1, "unknown"], [2, "ok"]])
  })
})

describe("filterGroups", () => {
  const groups = groupRuns(
    [
      entry("[run] ok-jig started (runId=1)", "info", 0),
      entry("[run.step] done jigId=ok-jig runId=1 seq=1 step=Fetch durationMs=4", "info", 1),
      entry("[run] ok-jig done in 5ms", "info", 2),
      entry("[run] bad-jig started (runId=2)", "info", 10),
      entry("[run.step] failed jigId=bad-jig runId=2 seq=1 step=Fetch durationMs=4 error=nope", "error", 11),
      entry("[run] bad-jig error: nope", "error", 12),
      entry("[scheduler] started (minute-aligned tick)", "info", 20),
    ].map(describeLog),
    T0 + 10_000
  )

  it("keeps only failed runs and error rows under the error level", () => {
    const out = filterGroups(groups, { level: "error", query: "", verbose: false })
    expect(out.map((g) => (g.type === "run" ? g.run.jigId : g.item.title))).toEqual(["bad-jig"])
    const bad = runsOf(out)[0]
    expect(bad.items.map((i) => i.title)).toEqual(["Step 1 failed"])
  })

  it("matches the query against the run header as well as its rows", () => {
    const out = filterGroups(groups, { level: "all", query: "ok-jig", verbose: false })
    expect(runsOf(out).map((r) => r.jigId)).toEqual(["ok-jig"])
  })

  it("shows lifecycle rows only in verbose mode", () => {
    const quiet = filterGroups(groups, { level: "all", query: "", verbose: false })
    const loud = filterGroups(groups, { level: "all", query: "", verbose: true })
    expect(runsOf(quiet)[0].items.map((i) => i.title)).toEqual(["Step 1 done"])
    expect(runsOf(loud)[0].items.map((i) => i.title)).toEqual(["Run started", "Step 1 done", "Run finished"])
  })
})

describe("isOperationalLog", () => {
  it("accepts step and connection lines the runner now emits", () => {
    expect(isOperationalLog(entry("[run.step] start jigId=a seq=1 step=Go"))).toBe(true)
    expect(isOperationalLog(entry("[mcp.connection] reconnect server=gmail"))).toBe(true)
    expect(isOperationalLog(entry("GET /api/health 200"))).toBe(false)
  })
})

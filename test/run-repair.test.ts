/**
 * Tests for the auto-repair trigger guards — behaviour-only, no LLM/session.
 * Uses the RepairDeps injection points so nothing touches the network or a
 * real authoring session. The guards are mechanical facts (streak window,
 * pending fix), never failure-reason inspection — see run-repair.ts header.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import {
  openDb,
  closeDb,
  recordEmailThread,
  getEmailThread,
  setEmailThreadSession,
  type RunRow,
  type StepRow,
} from "../src/db.js"
import { maybeStartAutoRepair, type RepairDeps } from "../src/services/run-repair.js"

type RunWithSteps = RunRow & { steps: StepRow[] }

let nextRunId = 1000

function run(status: RunRow["status"], opts: { error?: string; stepError?: string; stepLabel?: string } = {}): RunWithSteps {
  const id = nextRunId--
  return {
    id,
    jig_id: "test-jig",
    started_at: "2026-07-06 00:00:00",
    finished_at: status === "running" ? null : "2026-07-06 00:01:00",
    status,
    duration_ms: 60_000,
    error: opts.error ?? (status === "fail" ? "boom" : null),
    output: null,
    params: null,
    steps: opts.stepError
      ? [{
          id, run_id: id, seq: 1, label: opts.stepLabel ?? "send report",
          started_at: null, finished_at: null, duration_ms: null,
          output: null, status: "fail", error: opts.stepError, connections: null,
        }]
      : [],
  }
}

function deps(runs: RunWithSteps[], overrides: RepairDeps = {}): { deps: RepairDeps; started: { instruction: string; jigId?: string }[] } {
  const started: { instruction: string; jigId?: string }[] = []
  return {
    started,
    deps: {
      getJigRuns: () => runs,
      getPending: () => null,
      startAgentSession: async (body: any) => {
        started.push({ instruction: body.instruction, jigId: body.jigId })
        return { sessionId: "session-1", jigId: body.jigId }
      },
      openEmailThread: async () => {},
      ...overrides,
    },
  }
}

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

describe("maybeStartAutoRepair guards", () => {
  it("skips a single failure", async () => {
    const { deps: d, started } = deps([run("fail"), run("success")])
    expect(await maybeStartAutoRepair("test-jig", 1, d)).toBeNull()
    expect(started).toHaveLength(0)
  })

  it("triggers on the 2nd consecutive failure", async () => {
    const { deps: d, started } = deps([run("fail"), run("fail"), run("success")])
    expect(await maybeStartAutoRepair("test-jig", 1, d)).toBe("session-1")
    expect(started).toHaveLength(1)
  })

  it("retries once on the 3rd failure (crash recovery), then stops", async () => {
    const three = deps([run("fail"), run("fail"), run("fail")])
    expect(await maybeStartAutoRepair("test-jig", 1, three.deps)).toBe("session-1")

    const four = deps([run("fail"), run("fail"), run("fail"), run("fail")])
    expect(await maybeStartAutoRepair("test-jig", 1, four.deps)).toBeNull()
    expect(four.started).toHaveLength(0)
  })

  it("a success resets the streak", async () => {
    const { deps: d, started } = deps([run("fail"), run("success"), run("fail"), run("fail"), run("fail")])
    expect(await maybeStartAutoRepair("test-jig", 1, d)).toBeNull()
    expect(started).toHaveLength(0)
  })

  it("ignores in-flight runs when counting the streak", async () => {
    const { deps: d } = deps([run("running"), run("fail"), run("fail")])
    expect(await maybeStartAutoRepair("test-jig", 1, d)).toBe("session-1")
  })

  it("skips when a fix already awaits approval", async () => {
    const { deps: d, started } = deps([run("fail"), run("fail")], {
      getPending: () => ({ diff: "..." }) as any,
    })
    expect(await maybeStartAutoRepair("test-jig", 1, d)).toBeNull()
    expect(started).toHaveLength(0)
  })

  it("skips quietly when another session holds the jig lock", async () => {
    const { deps: d } = deps([run("fail"), run("fail")], {
      startAgentSession: async () => {
        throw new Error("An agent session is already editing this jig")
      },
    })
    expect(await maybeStartAutoRepair("test-jig", 1, d)).toBeNull()
  })
})

describe("repair instruction", () => {
  it("carries the failing step and its error, and the honesty rule", async () => {
    const { deps: d, started } = deps([
      run("fail", { stepError: "gmail send rejected: html body not allowed", stepLabel: "email digest" }),
      run("fail"),
    ])
    await maybeStartAutoRepair("test-jig", 1, d)
    const instruction = started[0].instruction
    expect(instruction).toContain('step "email digest"')
    expect(instruction).toContain("html body not allowed")
    expect(instruction).toContain("explain the concrete blocker")
    expect(started[0].jigId).toBe("test-jig")
  })

  it("prefers the step error over the run rollup and truncates long errors", async () => {
    const long = "x".repeat(5000)
    const { deps: d, started } = deps([run("fail", { error: "rollup", stepError: long }), run("fail")])
    await maybeStartAutoRepair("test-jig", 1, d)
    expect(started[0].instruction).not.toContain("rollup")
    expect(started[0].instruction.length).toBeLessThan(2500)
  })
})

// The 'propose' approval mode must persist on the thread (migration v19), not
// just live in memory — otherwise a revision/question reply defaults to 'auto'
// and the unsolicited fix self-ships without an explicit "apply" (BUG 1).
describe("email thread approval mode (propose persistence)", () => {
  it("defaults a thread to 'auto' and round-trips 'propose'", () => {
    recordEmailThread("thread-solicited", "jig-a")
    expect(getEmailThread("thread-solicited")?.approval).toBe("auto")

    recordEmailThread("thread-repair", "jig-b", "propose")
    expect(getEmailThread("thread-repair")?.approval).toBe("propose")
  })

  it("keeps 'propose' across a session mapping update", () => {
    recordEmailThread("thread-repair", "jig-b", "propose")
    setEmailThreadSession("thread-repair", "sess-xyz")
    const row = getEmailThread("thread-repair")
    expect(row?.approval).toBe("propose")
    expect(row?.agent_session_id).toBe("sess-xyz")
  })
})

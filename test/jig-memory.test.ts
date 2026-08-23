import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { clearJigMemory, closeDb, countJigMemory, MEMORY_MAX_KEYS_PER_JIG, openDb, setJigMemory } from "../src/db.js"
import { setDryRun } from "../src/sdk/dryrun.js"
import { Context } from "../src/sdk/context.js"

const JIG = "todo"

function ctx(jigId: string | undefined = JIG) {
  return new Context({}, { jigId })
}

describe("ctx.memory", () => {
  beforeEach(() => { openDb() })
  afterEach(() => {
    setDryRun(false)
    clearJigMemory(JIG)
    clearJigMemory("other")
    closeDb()
  })

  it("remembers a value across contexts, which is what a later run gets", async () => {
    await ctx().memory.set("todo:42", { title: "Renew passport", done: false })
    // A separate Context is exactly what the next run receives.
    expect(await ctx().memory.get<{ title: string; done: boolean }>("todo:42")).toEqual({ title: "Renew passport", done: false })
  })

  it("returns null for a key never written", async () => {
    expect(await ctx().memory.get("nope")).toBeNull()
  })

  it("overwrites rather than duplicating", async () => {
    await ctx().memory.set("k", 1)
    await ctx().memory.set("k", 2)
    expect(await ctx().memory.get<number>("k")).toBe(2)
    expect(countJigMemory(JIG)).toBe(1)
  })

  it("round-trips arrays, nulls, and booleans without stringifying them", async () => {
    const m = ctx().memory
    await m.set("arr", [1, "two", { three: true }])
    await m.set("nul", null)
    await m.set("bool", false)
    expect(await m.get<unknown[]>("arr")).toEqual([1, "two", { three: true }])
    expect(await m.get("nul")).toBeNull()
    expect(await m.get<boolean>("bool")).toBe(false)
  })

  // The whole point of scoping: two jigs using the obvious key name "state"
  // must not read or clobber each other.
  it("scopes keys per jig", async () => {
    await ctx(JIG).memory.set("state", "mine")
    await ctx("other").memory.set("state", "theirs")
    expect(await ctx(JIG).memory.get<string>("state")).toBe("mine")
    expect(await ctx("other").memory.get<string>("state")).toBe("theirs")
  })

  it("lists by prefix, in key order", async () => {
    const m = ctx().memory
    await m.set("todo:b", 2)
    await m.set("todo:a", 1)
    await m.set("seen:x", 9)
    expect(await m.list("todo:")).toEqual([
      { key: "todo:a", value: 1 },
      { key: "todo:b", value: 2 },
    ])
  })

  it("lists everything when given no prefix", async () => {
    const m = ctx().memory
    await m.set("todo:a", 1)
    await m.set("seen:x", 9)
    expect((await m.list()).map((r) => r.key)).toEqual(["seen:x", "todo:a"])
  })

  // A key containing % would otherwise match every key as a LIKE wildcard.
  it("treats LIKE wildcards in a prefix literally", async () => {
    const m = ctx().memory
    await m.set("100%:done", "match")
    await m.set("100X:done", "should not match")
    expect(await m.list("100%")).toEqual([{ key: "100%:done", value: "match" }])
  })

  it("deletes, reporting whether anything was there", async () => {
    const m = ctx().memory
    await m.set("k", 1)
    expect(await m.delete("k")).toBe(true)
    expect(await m.delete("k")).toBe(false)
    expect(await m.get("k")).toBeNull()
  })

  // A dry run must not mutate state the next real run reads.
  it("does not write during a dry run", async () => {
    await ctx().memory.set("k", "real")
    setDryRun(true)
    const c = ctx()
    await c.memory.set("k", "dry")
    await c.memory.delete("k")
    setDryRun(false)

    expect(await ctx().memory.get<string>("k")).toBe("real")
  })

  // Reads stay live so a dry-run preview reflects the state the jig would see.
  it("still reads real values during a dry run", async () => {
    await ctx().memory.set("k", "real")
    setDryRun(true)
    expect(await ctx().memory.get<string>("k")).toBe("real")
  })

  it("reports the dry-run write in the run output", async () => {
    setDryRun(true)
    const c = ctx()
    await c.memory.set("k", "v")
    expect(c.getOutput().join("\n")).toContain("[dry-run] would remember k")
  })

  it("rejects a value past the size cap instead of truncating it", async () => {
    const huge = "x".repeat(70_000)
    expect(ctx().memory.set("big", huge)).rejects.toThrow(/over the \d+ limit/)
  })

  it("rejects an empty key", async () => {
    expect(ctx().memory.set("", 1)).rejects.toThrow(/non-empty string/)
  })

  it("rejects a value that cannot be JSON-encoded", async () => {
    const cyclic: any = {}
    cyclic.self = cyclic
    expect(ctx().memory.set("cyclic", cyclic)).rejects.toThrow()
  })

  // A jig writing a fresh key every run would otherwise grow jig.db without
  // bound, on the same volume as credentials and run history.
  it("refuses a new key once the jig is at its key cap", async () => {
    for (let i = 0; i < MEMORY_MAX_KEYS_PER_JIG; i++) setJigMemory(JIG, `k${i}`, "1")
    expect(ctx().memory.set("one-more", 1)).rejects.toThrow(/full for this jig/)
  })

  it("still allows overwriting an existing key at the cap", async () => {
    for (let i = 0; i < MEMORY_MAX_KEYS_PER_JIG; i++) setJigMemory(JIG, `k${i}`, "1")
    await ctx().memory.set("k0", "updated")
    expect(await ctx().memory.get<string>("k0")).toBe("updated")
  })

  // Running a jig by file path gives no jig identity, and silently discarding
  // writes would look like data loss at the next run.
  it("fails loudly when the run has no jig identity", async () => {
    const anonymous = new Context({})
    expect(anonymous.memory.set("k", 1)).rejects.toThrow(/needs a jig identity/)
    expect(anonymous.memory.get("k")).rejects.toThrow(/needs a jig identity/)
  })

  // A value hand-edited outside the SDK must not break every run that reads near it.
  it("hands back a non-JSON stored value as a raw string", async () => {
    setJigMemory(JIG, "hand-edited", "not json{")
    expect(await ctx().memory.get<string>("hand-edited")).toBe("not json{")
  })
})

describe("ctx.once", () => {
  beforeEach(() => { openDb() })
  afterEach(() => {
    setDryRun(false)
    clearJigMemory(JIG)
    closeDb()
  })

  it("runs the first time and skips every time after", async () => {
    let runs = 0
    const inc = async () => { runs++ }

    expect(await ctx().once("coached:m1", inc)).toBe(true)
    expect(await ctx().once("coached:m1", inc)).toBe(false)
    expect(await ctx().once("coached:m1", inc)).toBe(false)
    expect(runs).toBe(1)
  })

  it("treats different keys as different work", async () => {
    let runs = 0
    const inc = async () => { runs++ }
    await ctx().once("coached:m1", inc)
    await ctx().once("coached:m2", inc)
    expect(runs).toBe(2)
  })

  // A 15-minute cron sees the same meeting on every tick. Each tick is a fresh
  // Context, so the guard has to survive across them or it guards nothing.
  it("holds across separate runs", async () => {
    let runs = 0
    await ctx().once("coached:m1", async () => { runs++ })
    await ctx().once("coached:m1", async () => { runs++ })
    expect(runs).toBe(1)
  })

  it("scopes the key per jig", async () => {
    let runs = 0
    const inc = async () => { runs++ }
    await ctx(JIG).once("k", inc)
    await ctx("other").once("k", inc)
    expect(runs).toBe(2)
    clearJigMemory("other")
  })

  // Otherwise a transient failure (API down) would permanently mark the item
  // done, and it would never be retried.
  it("releases the key when the work throws, so the next run retries", async () => {
    await expect(ctx().once("coached:m1", async () => { throw new Error("api down") }))
      .rejects.toThrow("api down")

    let retried = false
    expect(await ctx().once("coached:m1", async () => { retried = true })).toBe(true)
    expect(retried).toBe(true)
  })

  // Claim-before-run: a crash mid-work costs one missed item, where
  // claim-after would repeat a side effect that already happened.
  it("records the key before running the work", async () => {
    let keyDuringRun: unknown = null
    await ctx().once("coached:m1", async () => {
      keyDuringRun = await ctx().memory.get("coached:m1")
    })
    expect(keyDuringRun).not.toBeNull()
  })

  it("runs but records nothing during a dry run", async () => {
    setDryRun(true)
    let runs = 0
    await ctx().once("coached:m1", async () => { runs++ })
    setDryRun(false)

    expect(runs).toBe(1)
    expect(await ctx().memory.get("coached:m1")).toBeNull()
  })
})

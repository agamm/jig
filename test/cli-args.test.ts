import { describe, expect, it } from "bun:test"
import { splitCliArgs } from "../src/domain/cli-args.js"

describe("splitCliArgs", () => {
  // The bug: --dry-run was stripped for every command, so `jig debug run
  // <jig> --dry-run` sent dryRun:false to the remote and performed a real run,
  // sending real email from a command whose whole point is not to.
  it("forwards --dry-run to remote subcommands", () => {
    const out = splitCliArgs(["debug", "run", "my-jig", "jig", "--dry-run"])
    expect(out.dryRun).toBe(true)
    expect(out.command).toBe("debug")
    expect(out.rest).toEqual(["run", "my-jig", "jig", "--dry-run"])
  })

  // Local runs get dry-run from setDryRun in-process, so the flag would only
  // confuse positional parsing if it were left in.
  it("strips it for local commands", () => {
    const out = splitCliArgs(["run", "my-jig", "--dry-run"])
    expect(out.dryRun).toBe(true)
    expect(out.rest).toEqual(["my-jig"])
  })

  it("leaves args alone when the flag is absent", () => {
    expect(splitCliArgs(["debug", "run", "my-jig"])).toEqual({
      dryRun: false, command: "debug", rest: ["run", "my-jig"],
    })
  })

  it("does not duplicate the flag if it is somehow already there", () => {
    const out = splitCliArgs(["debug", "run", "--dry-run", "my-jig"])
    expect(out.rest.filter((a) => a === "--dry-run")).toHaveLength(1)
  })

  it("handles an empty command line", () => {
    expect(splitCliArgs([])).toEqual({ dryRun: false, command: undefined, rest: [] })
  })

  // Same failure mode as `jig debug run`: the flag was stripped before the
  // subcommand saw it, so `jig backup restore x.zip --dry-run` overwrote the
  // instance it was supposed to be previewing.
  it("forwards --dry-run to backup restore, which previews rather than applies", () => {
    const out = splitCliArgs(["backup", "restore", "b.zip", "--dry-run"])

    expect(out.command).toBe("backup")
    expect(out.rest).toEqual(["restore", "b.zip", "--dry-run"])
  })

  it("leaves a plain backup untouched", () => {
    expect(splitCliArgs(["backup", "--out", "b.zip"])).toEqual({
      dryRun: false, command: "backup", rest: ["--out", "b.zip"],
    })
  })
})

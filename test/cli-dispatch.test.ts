import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * A bad slice in an edit duplicated the whole `try { switch (command) }` block.
 * Both copies ran, so every command ending in `break` rather than `process.exit`
 * executed TWICE: `jig connect` printed the server list twice, and anything with
 * side effects would have done them twice. It typechecked cleanly, which is why
 * this guard is structural rather than behavioural.
 */
describe("cli dispatch", () => {
  const source = readFileSync("src/cli.ts", "utf-8")

  it("has exactly one command switch", () => {
    expect(source.match(/switch \(command\)/g)?.length ?? 0).toBe(1)
  })

  it("has exactly one help block", () => {
    expect(source.match(/console\.log\(`Commands:`\)/g)?.length ?? 0).toBe(1)
  })

  it("declares each command case once", () => {
    const cases = [...source.matchAll(/^\s{4}case "([a-z-]+)":/gm)].map((m) => m[1])
    const dupes = cases.filter((c, i) => cases.indexOf(c) !== i)
    expect({ duplicateCases: [...new Set(dupes)] }).toEqual({ duplicateCases: [] })
  })
})

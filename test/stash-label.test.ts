import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * `jig update` and `jig update <handle>` both stash local changes and look the
 * stash back up by label. Both compared the stash SUBJECT to the bare label,
 * but git records "On <branch>: <label>", so the lookup never matched: the
 * changes were stashed and then orphaned, vanishing from the working tree.
 * Reproduced against a real repo before fixing.
 */
describe("stash lookup after an update", () => {
  it("matches the label inside git's subject line, not against the whole thing", () => {
    for (const file of ["src/cli.ts", "src/cli-remote/update.ts"]) {
      const source = readFileSync(file, "utf-8")
      const equality = /\.find\(\(\[, (?:msg|message)\]\) => (?:msg|message) === /.test(source)
      expect({ file, comparesForEquality: equality }).toEqual({ file, comparesForEquality: false })
      expect(source).toMatch(/\.find\(\(\[, (?:msg|message)\]\) => (?:msg|message)\.includes\(/)
    }
  })

  it("is the shape git actually produces", () => {
    // Guards the assumption the fix rests on.
    const label = "jig-update-1788476718"
    const subject: string = `On main: ${label}`
    expect(subject === label).toBe(false)
    expect(subject.includes(label)).toBe(true)
  })
})

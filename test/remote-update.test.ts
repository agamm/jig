import { describe, expect, it } from "bun:test"
import { compareSemver, decideUpdate, parseSemverTag, releaseTagCandidates } from "../src/cli-remote/update.js"

describe("releaseTagCandidates", () => {
  it("accepts either common exact-tag spelling without inventing a commit", () => {
    expect(releaseTagCandidates("0.1.105")).toEqual(["v0.1.105", "0.1.105"])
    expect(releaseTagCandidates("v0.1.105")).toEqual(["v0.1.105", "0.1.105"])
  })

  it("rejects versions that cannot name a release tag", () => {
    expect(releaseTagCandidates("0.1.105-dev")).toEqual([])
  })
})

describe("decideUpdate", () => {
  it("refuses to move an instance backwards onto an older tag", () => {
    // The real shape of the bug: package.json ran ahead of the tags, so the
    // newest tag was v0.1.57 while deployed instances were on 0.1.105. String
    // equality said "not current" and the updater checked out the OLD tag.
    const decision = decideUpdate("0.1.105", "v0.1.57")

    expect(decision.action).toBe("ahead")
    expect(decision.messages.join(" ")).toMatch(/newer than the latest tag/)
  })

  it("updates when the tag is genuinely newer", () => {
    expect(decideUpdate("0.1.105", "v0.2.0").action).toBe("update")
    expect(decideUpdate("0.1.105", "v0.1.106").action).toBe("update")
  })

  it("treats a matching tag as current, with or without the v", () => {
    expect(decideUpdate("0.1.105", "v0.1.105").action).toBe("current")
    expect(decideUpdate("0.1.105", "0.1.105").action).toBe("current")
  })

  it("refuses to guess a direction it cannot compute", () => {
    // A pre-release or a dirty version string must not be treated as older.
    const decision = decideUpdate("0.1.105-dev", "v0.1.57")
    expect(decision.action).toBe("ahead")
    expect(decision.messages.join(" ")).toMatch(/Refusing to deploy blind/)
  })

  it("compares minor and patch numerically, not lexically", () => {
    // "0.1.9" > "0.1.10" as strings; the whole point is that it isn't here.
    expect(compareSemver(parseSemverTag("v0.1.10")!, parseSemverTag("v0.1.9")!)).toBeGreaterThan(0)
    expect(decideUpdate("0.1.9", "v0.1.10").action).toBe("update")
    expect(decideUpdate("0.1.10", "v0.1.9").action).toBe("ahead")
  })
})

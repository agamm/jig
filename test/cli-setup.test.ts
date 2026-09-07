import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

/**
 * The machine that runs `jig setup` pairs itself; the user's own checkout does
 * not. The setup run is the one moment a session exists to mint a code with,
 * so both ways out of setup (walked the steps, or already done) print one.
 */
describe("jig setup hands over a pairing command", () => {
  const source = readFileSync("src/cli-setup/index.ts", "utf-8")

  it("prints it after the flow completes and on the already-set-up path, for hosted instances only", () => {
    const calls = [...source.matchAll(/if \(hostedRemote\) await printPairingCommand\(base, cookie\)/g)]
    expect(calls).toHaveLength(2)
    const complete = source.lastIndexOf("await completeSetup(base, cookie)")
    expect(source.indexOf("if (hostedRemote) await printPairingCommand(base, cookie)", complete)).toBeGreaterThan(complete)
  })

  it("mints the code on the instance and prints the one-line pair command", () => {
    expect(source).toMatch(/fetch\(`\$\{base\}\/api\/cli\/pair`, \{ method: "POST"/)
    expect(source).toMatch(/bunx --bun github:agamm\/jig pair \$\{code\} --url=\$\{base\}/)
  })
})

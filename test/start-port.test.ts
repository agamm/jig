import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"

describe("local start port handling", () => {
  const source = readFileSync("src/start.ts", "utf-8")

  it("never kills the current listener by default or without a TTY", () => {
    const ensurePort = source.slice(source.indexOf("async function ensurePortLocal"), source.indexOf("function tryServe"))
    expect(ensurePort).toContain("[y/N]")
    expect(ensurePort).not.toContain("[Y/n]")
    expect(ensurePort).toContain("process.stdin.isTTY && process.stdout.isTTY")
    expect(ensurePort.indexOf('startsWith("y")')).toBeLessThan(ensurePort.indexOf('process.kill(pid, "SIGTERM")'))
  })
})

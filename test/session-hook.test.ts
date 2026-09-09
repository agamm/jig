import { describe, expect, it } from "bun:test"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The session-start hook: Claude Code runs `jig debug audit --hook` when a
 * session opens in this checkout, so the paired instance's failures are in
 * context before any jig is edited. The hook must never break a session: no
 * output without a paired instance, one line when the instance cannot answer,
 * exit 0 in every case.
 */
function runHook(remotesDir: string): { stdout: string; stderr: string; exitCode: number } {
  const proc = Bun.spawnSync({
    cmd: ["bun", "run", "src/cli.ts", "debug", "audit", "--hook"],
    env: { ...process.env, JIG_REMOTES_DIR: remotesDir },
    stdout: "pipe",
    stderr: "pipe",
  })
  return { stdout: proc.stdout.toString(), stderr: proc.stderr.toString(), exitCode: proc.exitCode ?? -1 }
}

describe("jig debug audit --hook", () => {
  it("prints nothing and exits 0 when this checkout is not paired to an instance", () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-hook-none-"))
    const result = runHook(dir)
    expect(result.stdout).toBe("")
    expect(result.exitCode).toBe(0)
  })

  it("prints one line and exits 0 when the paired instance cannot answer", () => {
    const dir = mkdtempSync(join(tmpdir(), "jig-hook-dead-"))
    writeFileSync(join(dir, "dead.json"), JSON.stringify({ handle: "dead", public_url: "http://127.0.0.1:9", session_cookie: "x" }))
    const result = runHook(dir)
    expect(result.exitCode).toBe(0)
    expect(result.stdout.trim().split("\n")).toHaveLength(1)
    expect(result.stdout).toContain("[jig] could not check dead for failures")
    expect(result.stdout).toContain("Run: bun run jig debug audit")
  })
})

describe("the shipped Claude Code hook", () => {
  it("runs the audit in hook mode at session start", () => {
    // Read from the checkout: if .gitignore swallowed the file again, a clone has no hook and this fails.
    const settings = JSON.parse(readFileSync(".claude/settings.json", "utf-8"))
    const commands = (settings.hooks.SessionStart as { hooks: { type: string; command: string }[] }[])
      .flatMap((entry) => entry.hooks)
      .filter((h) => h.type === "command")
      .map((h) => h.command)
    expect(commands).toHaveLength(1)
    expect(commands[0]).toContain("bun run --silent jig debug audit --hook")
    expect(commands[0]).toMatch(/\|\| true$/)
  })

  it("is the one file under .claude/ that git tracks", () => {
    const ignore = readFileSync(".gitignore", "utf-8")
    expect(ignore).toContain("\n.claude/*\n!.claude/settings.json\n")
    expect(ignore).not.toMatch(/^\.claude\/$/m)
  })
})

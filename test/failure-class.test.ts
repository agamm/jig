/**
 * The failure classifier: one real error string per class, and the remedy
 * names the exact next command with the server or jig filled in.
 */
import { describe, expect, it } from "bun:test"
import { classifyFailure } from "../src/services/failure-class.js"
import type { FailureCause } from "../shared/api.js"

const ctx = { jigId: "post-meeting-coach", connections: ["composio"] }

describe("classifyFailure", () => {
  const cases: [string, FailureCause][] = [
    ["composio: response was too large to return inline (~24000 tokens) and was spilled to /mnt/files/out.json, which is unreachable from the MCP session.", "composio-spill"],
    ["jig is locked — unlock with password to access credentials", "locked"],
    ["Connection required: granola", "missing-connection"],
    ["granola: authorization expired or was revoked — reconnect it from the dashboard (Connections → granola).", "auth"],
    ["401 Unauthorized", "auth"],
    ["OAuth error: invalid_grant", "auth"],
    ["Invalid refresh token", "auth"],
    ["402 Insufficient credits. Add more using https://openrouter.ai/settings/credits", "credits"],
    ["429 Rate limit exceeded", "rate-limit"],
    ["Quota exceeded for quota metric 'Queries' and limit 'Queries per day'", "rate-limit"],
    ["502 Bad Gateway", "provider"],
    ["MCP error -32000: Upstream MCP server error", "provider"],
    ["SSE error: Non-200 status code (503)", "provider"],
    ["fetch failed: ECONNRESET", "provider"],
    ["Run timed out after 10 minutes", "timeout"],
    ["Cannot read properties of undefined (reading 'items')", "code"],
    ["Jig validation failed: Jig has no ctx.step() calls.", "code"],
  ]
  for (const [error, cause] of cases) {
    it(`${cause}: ${error.slice(0, 40)}`, () => {
      expect(classifyFailure(error, ctx).cause).toBe(cause)
    })
  }

  it("treats a missing error as a code failure with the edit command", () => {
    const v = classifyFailure(null, ctx)
    expect(v.cause).toBe("code")
    expect(v.remedy).toContain("bun run jig edit post-meeting-coach --out=post-meeting-coach.ts")
  })

  it("names the server to reconnect from the message, else from the step's connections", () => {
    expect(classifyFailure("granola: authorization expired or was revoked — reconnect it", { jigId: "x", connections: ["composio"] }).remedy)
      .toContain("bun run jig connect granola")
    expect(classifyFailure("401 Unauthorized", { jigId: "x", connections: ["linear"] }).remedy)
      .toContain("bun run jig connect linear")
    expect(classifyFailure("401 Unauthorized", { jigId: "x" }).remedy).toContain("bun run jig connect <server>")
  })

  it("names the missing connection from the preflight message", () => {
    expect(classifyFailure("Connection required: granola", { jigId: "x" }).remedy).toContain("bun run jig connect granola")
  })

  it("points a Composio spill at the service's own server", () => {
    const v = classifyFailure("composio: response was too large to return inline and was spilled to /mnt/files/a.json", ctx)
    expect(v.remedy).toMatch(/bun run jig connect <service>/)
    expect(v.remedy).toMatch(/max_results/)
  })

  it("prefers the specific external cause over the generic status code", () => {
    // A 504 is a provider failure, not a timeout of our own making.
    expect(classifyFailure("504 Gateway Timeout", ctx).cause).toBe("provider")
  })
})

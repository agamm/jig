/**
 * Smoke tests for the API router — verifies the paths the dashboard calls
 * resolve to the handlers server.ts implements.
 */
import { describe, it, expect } from "bun:test"
import { matchRoute } from "../src/server/router.js"

describe("router", () => {
  it("matches the live updates route", () => {
    const r = matchRoute("/api/events")
    expect(r?.handler).toBe("liveUpdates")
  })

  it("matches the connection connect route", () => {
    const r = matchRoute("/api/connections/workspace/connect")
    expect(r?.handler).toBe("connectConnection")
    expect(r?.params.name).toBe("workspace")
  })

  // /api/connections/:name is declared after the sub-routes; if that order ever
  // flips, this resolves to getConnection with name="composio" and every eval
  // silently returns connection metadata instead of calling the tool.
  it("matches the tool eval route rather than the connection route", () => {
    const r = matchRoute("/api/connections/composio/eval")
    expect(r?.handler).toBe("evalTool")
    expect(r?.params.name).toBe("composio")
  })

  it("still matches the bare connection route", () => {
    expect(matchRoute("/api/connections/composio")?.handler).toBe("getConnection")
  })

  // Declared before /api/connections/:name for the same reason as the
  // sub-routes: otherwise "types" would be treated as a connection name.
  it("matches the connection types route rather than a connection named types", () => {
    expect(matchRoute("/api/connections/types")?.handler).toBe("connectionTypes")
  })

  it("matches the examples route", () => {
    const r = matchRoute("/api/examples")
    expect(r?.handler).toBe("listExamples")
  })

  it("matches the add-example route", () => {
    const r = matchRoute("/api/examples/weekly-update/add")
    expect(r?.handler).toBe("addExample")
    expect(r?.params.id).toBe("weekly-update")
  })

  it("matches the agentmail settings routes", () => {
    expect(matchRoute("/api/settings/agentmail")?.handler).toBe("agentMailSettings")
    expect(matchRoute("/api/settings/agentmail/setup")?.handler).toBe("agentMailSetup")
    expect(matchRoute("/api/settings/agentmail/test")?.handler).toBe("agentMailTest")
  })

  it("no longer serves the removed MCP-channel notification routes", () => {
    expect(matchRoute("/api/settings/notifications")).toBeNull()
    expect(matchRoute("/api/settings/notifications/test")).toBeNull()
  })

  it("matches the local reset route", () => {
    const r = matchRoute("/api/settings/reset-local")
    expect(r?.handler).toBe("resetLocalState")
  })

  it("does not match an unrelated path", () => {
    expect(matchRoute("/api/settings/other")).toBeNull()
  })

  it("prefers a literal path over the pattern that would swallow it", () => {
    expect(matchRoute("/api/connections/custom")?.handler).toBe("createCustomConnection")
    expect(matchRoute("/api/runs/active")?.handler).toBe("activeRun")
    expect(matchRoute("/api/runs/cancel")?.handler).toBe("cancelRun")
  })

  it("rejects an invalid jig id at the router rather than in the handler", () => {
    expect(matchRoute("/api/jigs/../etc")).toBeNull()
    expect(matchRoute("/api/jigs/a%2Fb/run")).toBeNull()
    expect(matchRoute("/api/schedules/../etc")).toBeNull()
    expect(matchRoute("/api/webhooks/../etc")).toBeNull()
    expect(matchRoute("/api/jigs/my-jig/run")?.params.id).toBe("my-jig")
  })

  it("requires run ids to be integers", () => {
    expect(matchRoute("/api/runs/12")?.params.id).toBe("12")
    expect(matchRoute("/api/runs/-5")?.params.id).toBe("-5")
    expect(matchRoute("/api/runs/abc")).toBeNull()
  })

  it("rejects empty path segments", () => {
    expect(matchRoute("/api/connections//connect")).toBeNull()
  })

  it("captures a sender id containing slashes", () => {
    const r = matchRoute("/api/authorized-senders/email/a/b/c")
    expect(r?.handler).toBe("deleteAuthorizedSender")
    expect(r?.params.channel).toBe("email")
    expect(r?.params.senderId).toBe("a/b/c")
  })
})

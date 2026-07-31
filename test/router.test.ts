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
    expect(matchRoute("/api/agent//stream")).toBeNull()
    expect(matchRoute("/api/connections//connect")).toBeNull()
  })

  it("captures a sender id containing slashes", () => {
    const r = matchRoute("/api/authorized-senders/email/a/b/c")
    expect(r?.handler).toBe("deleteAuthorizedSender")
    expect(r?.params.channel).toBe("email")
    expect(r?.params.senderId).toBe("a/b/c")
  })

  it("distinguishes agent sub-routes from the status route", () => {
    expect(matchRoute("/api/agent/s1")?.handler).toBe("agentStatus")
    expect(matchRoute("/api/agent/s1/stream")?.handler).toBe("agentStream")
    expect(matchRoute("/api/agent/s1/message")?.handler).toBe("agentMessage")
    expect(matchRoute("/api/agent/s1/approve")?.handler).toBe("agentApprove")
    expect(matchRoute("/api/agent/s1/close")?.handler).toBe("agentClose")
  })
})

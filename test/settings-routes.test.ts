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
})

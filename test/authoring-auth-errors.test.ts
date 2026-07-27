import { describe, expect, it } from "bun:test"
import { isAuthDeniedError } from "../src/mcp/client.js"
import { authoringDiscoveryConnectError } from "../src/jig-gen.js"

describe("isAuthDeniedError", () => {
  it("detects plain Invalid refresh token errors from providers like Apify", () => {
    expect(isAuthDeniedError(new Error("Invalid refresh token"))).toBe(true)
  })

  it("detects expired refresh token wording", () => {
    expect(isAuthDeniedError(new Error("refresh token expired"))).toBe(true)
  })

  it("does not treat unrelated errors as auth", () => {
    expect(isAuthDeniedError(new Error("SSE error: Non-200 status code (405)"))).toBe(false)
  })
})

describe("authoringDiscoveryConnectError", () => {
  it("wraps Invalid refresh token as auth-required with reconnect details", () => {
    const err = authoringDiscoveryConnectError("apify", new Error("Invalid refresh token"))
    expect(err.code).toBe("auth-required")
    expect(err.message).toContain("apify")
    expect(err.message).toContain("reconnect")
    expect(err.details).toMatchObject({
      requiredConnections: ["apify"],
      reconnectConnections: ["apify"],
      connectionStatuses: [{ name: "apify", connected: true, authRequired: true }],
    })
  })

  it("wraps non-auth failures as authoring-discovery-failed", () => {
    const err = authoringDiscoveryConnectError("apify", new Error("network down"))
    expect(err.code).toBe("authoring-discovery-failed")
    expect(err.message).toContain("network down")
  })
})

import { afterEach, describe, expect, it } from "bun:test"
import { openRouterCallbackUrl } from "../src/services/openrouter-oauth.js"

const SERVICE_VARS = ["JIG_PUBLIC_URL", "RAILWAY_ENVIRONMENT_ID", "RAILWAY_PROJECT_ID", "RAILWAY_PUBLIC_DOMAIN"] as const
const saved = Object.fromEntries(SERVICE_VARS.map((k) => [k, process.env[k]]))

afterEach(() => {
  for (const k of SERVICE_VARS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

function serviceModeWithoutDomain() {
  for (const k of SERVICE_VARS) delete process.env[k]
  // Railway sets these from first boot; RAILWAY_PUBLIC_DOMAIN is the one that
  // may be missing, which is exactly the state that broke authorization.
  process.env.RAILWAY_ENVIRONMENT_ID = "env_123"
}

describe("openRouterCallbackUrl", () => {
  it("falls back to the origin the request arrived on when the platform set no domain", () => {
    serviceModeWithoutDomain()
    expect(openRouterCallbackUrl("https://jig-abc.up.railway.app")).toBe(
      "https://jig-abc.up.railway.app/api/openrouter/callback",
    )
  })

  it("prefers the platform URL over the request origin", () => {
    for (const k of SERVICE_VARS) delete process.env[k]
    // RAILWAY_PUBLIC_DOMAIN alone is not a service-mode signal; Railway sets the
    // environment id too, and isServiceMode() keys off that.
    process.env.RAILWAY_ENVIRONMENT_ID = "env_123"
    process.env.RAILWAY_PUBLIC_DOMAIN = "jig-real.up.railway.app"
    expect(openRouterCallbackUrl("https://someone-elses-proxy.example")).toBe(
      "https://jig-real.up.railway.app/api/openrouter/callback",
    )
  })

  it("says how to fix it when there is no way to work out an address", () => {
    serviceModeWithoutDomain()
    expect(() => openRouterCallbackUrl()).toThrow(/JIG_PUBLIC_URL/)
  })

  it("uses the local API port when not hosted", () => {
    for (const k of SERVICE_VARS) delete process.env[k]
    process.env.JIG_API_PORT = "4173"
    expect(openRouterCallbackUrl()).toBe("http://localhost:4173/api/openrouter/callback")
  })
})

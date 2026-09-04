import { describe, expect, it } from "bun:test"
import { assertPublicUrl } from "../src/net/ssrf.js"

describe("assertPublicUrl", () => {
  it("accepts a public literal address without network access", async () => {
    expect((await assertPublicUrl("https://1.1.1.1/mcp")).href).toBe("https://1.1.1.1/mcp")
  })

  it("rejects loopback and cloud metadata addresses", async () => {
    await expect(assertPublicUrl("http://127.0.0.1/private")).rejects.toThrow(/Blocked address/)
    await expect(assertPublicUrl("http://169.254.169.254/latest/meta-data")).rejects.toThrow(/Blocked address/)
  })
})

/**
 * Tests for SQLite-backed OAuth token storage.
 *
 * Ensures JigOAuthProvider round-trips tokens, client info, and the PKCE
 * code verifier through the credentials table under namespaced keys.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { closeDb, openDb, getCredential, listCredentials } from "../src/db.js"
import { JigOAuthProvider } from "../src/mcp/auth.js"

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

describe("JigOAuthProvider SQLite storage", () => {
  it("returns undefined when no tokens are stored", async () => {
    const provider = new JigOAuthProvider("testserver")
    expect(await provider.tokens()).toBeUndefined()
  })

  it("returns undefined when no client info is stored", async () => {
    const provider = new JigOAuthProvider("testserver")
    expect(await provider.clientInformation()).toBeUndefined()
  })

  it("round-trips OAuth tokens", async () => {
    const provider = new JigOAuthProvider("composio")
    const tokens = {
      access_token: "tok_abc123",
      refresh_token: "refresh_xyz",
      token_type: "Bearer",
      expires_in: 3600,
    }
    await provider.saveTokens(tokens as any)

    const loaded = await provider.tokens()
    expect(loaded).toEqual(tokens as any)
  })

  it("round-trips client information", async () => {
    const provider = new JigOAuthProvider("composio")
    const clientInfo = {
      client_id: "client_abc",
      redirect_uris: ["http://localhost:9876/callback"],
      client_id_issued_at: 1775436724,
    }
    await provider.saveClientInformation(clientInfo as any)

    const loaded = await provider.clientInformation()
    expect(loaded).toEqual(clientInfo as any)
  })

  it("round-trips the PKCE code verifier", async () => {
    const provider = new JigOAuthProvider("composio")
    const verifier = "random-pkce-verifier-string-xyz123"
    await provider.saveCodeVerifier(verifier)

    expect(await provider.codeVerifier()).toBe(verifier)
  })

  it("throws when code verifier is missing", async () => {
    const provider = new JigOAuthProvider("testserver")
    await expect(provider.codeVerifier()).rejects.toThrow("No code verifier saved")
  })

  it("namespaces credentials by server to avoid collisions", async () => {
    const composio = new JigOAuthProvider("composio")
    const granola = new JigOAuthProvider("granola")

    await composio.saveTokens({ access_token: "composio-token" } as any)
    await granola.saveTokens({ access_token: "granola-token" } as any)

    expect((await composio.tokens() as any).access_token).toBe("composio-token")
    expect((await granola.tokens() as any).access_token).toBe("granola-token")
  })

  it("stores tokens under the oauth:{server}:tokens key", async () => {
    const provider = new JigOAuthProvider("composio")
    await provider.saveTokens({ access_token: "abc" } as any)

    const raw = getCredential("oauth:composio:tokens")
    expect(raw).not.toBeNull()
    expect(JSON.parse(raw!)).toEqual({ access_token: "abc" } as any)
  })

  it("tags credentials with the server name for filtering", async () => {
    const provider = new JigOAuthProvider("composio")
    await provider.saveTokens({ access_token: "abc" } as any)
    await provider.saveClientInformation({ client_id: "c1" } as any)
    await provider.saveCodeVerifier("v1")

    const composioCreds = listCredentials("composio")
    const keys = composioCreds.map(c => c.key).sort()
    expect(keys).toEqual([
      "oauth:composio:client",
      "oauth:composio:tokens",
      "oauth:composio:verifier",
    ])
  })

  it("overwrites existing tokens on repeat save (idempotent refresh)", async () => {
    const provider = new JigOAuthProvider("composio")
    await provider.saveTokens({ access_token: "v1" } as any)
    await provider.saveTokens({ access_token: "v2" } as any)

    expect((await provider.tokens() as any).access_token).toBe("v2")
    // Only one row, not two
    expect(listCredentials("composio").length).toBe(1)
  })

  it("returns undefined (not throws) when stored tokens JSON is corrupted", async () => {
    const { setCredential } = await import("../src/db.js")
    setCredential("oauth:composio:tokens", "not-valid-json{", "composio")

    const provider = new JigOAuthProvider("composio")
    expect(await provider.tokens()).toBeUndefined()
  })
})

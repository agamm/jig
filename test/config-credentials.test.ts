/**
 * Tests for $VAR credential resolution in server configs.
 *
 * Servers can reference secrets via $VAR syntax in urls/headers. Values are
 * resolved exclusively from the SQLite credentials table (never env vars —
 * credentials are runtime state, env is static config).
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { existsSync, readFileSync, rmSync, writeFileSync } from "fs"
import { openDb, closeDb, setCredential } from "../src/db.js"
import { CUSTOM_SERVERS_PATH } from "../src/config/paths.js"
import { resolveCredentials, checkMissingCredentials, createCustomRemoteServer, loadCustomServerConfigs, loadServerConfigs } from "../src/mcp/config.js"

beforeEach(() => {
  closeDb()
  openDb(":memory:")
})

afterEach(() => {
  closeDb()
})

describe("resolveCredentials", () => {
  it("leaves strings without $VARs unchanged", () => {
    const { resolved, missing } = resolveCredentials("https://example.com/mcp")
    expect(resolved).toBe("https://example.com/mcp")
    expect(missing).toEqual([])
  })

  it("substitutes $VAR from the SQLite credentials table", () => {
    setCredential("COMPOSIO_API_KEY", "ck_abc123", "composio")
    const { resolved, missing } = resolveCredentials("Bearer $COMPOSIO_API_KEY")
    expect(resolved).toBe("Bearer ck_abc123")
    expect(missing).toEqual([])
  })

  it("reports missing vars and leaves them as literals", () => {
    const { resolved, missing } = resolveCredentials("Bearer $NOT_IN_DB")
    expect(resolved).toBe("Bearer $NOT_IN_DB")
    expect(missing).toEqual(["NOT_IN_DB"])
  })

  it("does NOT fall back to process.env even when env var is set", () => {
    // Env vars are for static config — credentials must live in SQLite.
    process.env.SHOULD_NOT_BE_USED = "from-env"
    try {
      const { resolved, missing } = resolveCredentials("$SHOULD_NOT_BE_USED")
      expect(resolved).toBe("$SHOULD_NOT_BE_USED")
      expect(missing).toEqual(["SHOULD_NOT_BE_USED"])
    } finally {
      delete process.env.SHOULD_NOT_BE_USED
    }
  })

  it("resolves multiple vars in one string", () => {
    setCredential("API_KEY", "aaa", "testsvc")
    setCredential("ORG_ID", "bbb", "testsvc")
    const { resolved, missing } = resolveCredentials("$API_KEY:$ORG_ID")
    expect(resolved).toBe("aaa:bbb")
    expect(missing).toEqual([])
  })

  it("tracks multiple missing vars", () => {
    const { missing } = resolveCredentials("$MISSING_A $MISSING_B")
    expect(missing).toEqual(["MISSING_A", "MISSING_B"])
  })

  it("only matches $VAR pattern with uppercase letters/underscores (no lowercase or leading digit)", () => {
    const { resolved, missing } = resolveCredentials("$lowercase $1digit $VALID")
    expect(resolved).toContain("$lowercase")
    expect(resolved).toContain("$1digit")
    expect(missing).toEqual(["VALID"])
  })
})

describe("checkMissingCredentials", () => {
  it("returns empty for stdio configs (no url/headers to resolve)", () => {
    const missing = checkMissingCredentials({
      type: "stdio",
      command: "npx",
      args: ["my-server"],
      description: "",
    } as any)
    expect(missing).toEqual([])
  })

  it("detects missing credentials in remote URL", () => {
    const missing = checkMissingCredentials({
      type: "remote",
      url: "https://api.example.com/$SERVER_ID",
      description: "",
    } as any)
    expect(missing).toEqual(["SERVER_ID"])
  })

  it("detects missing credentials in headers", () => {
    const missing = checkMissingCredentials({
      type: "remote",
      url: "https://api.example.com",
      description: "",
      headers: { "x-api-key": "$MY_KEY", "x-org": "$ORG_ID" },
    } as any)
    expect(missing.sort()).toEqual(["MY_KEY", "ORG_ID"])
  })

  it("dedupes credentials that appear in both url and headers", () => {
    const missing = checkMissingCredentials({
      type: "remote",
      url: "https://api.example.com/$KEY",
      description: "",
      headers: { "x-api-key": "$KEY" },
    } as any)
    expect(missing).toEqual(["KEY"])
  })

  it("returns empty when all credentials are stored", () => {
    setCredential("MY_KEY", "secret", "testsvc")
    const missing = checkMissingCredentials({
      type: "remote",
      url: "https://api.example.com",
      description: "",
      headers: { "x-api-key": "$MY_KEY" },
    } as any)
    expect(missing).toEqual([])
  })
})

describe("custom server configs", () => {
  let customServersBackup: string | null = null

  beforeEach(() => {
    customServersBackup = existsSync(CUSTOM_SERVERS_PATH) ? readFileSync(CUSTOM_SERVERS_PATH, "utf-8") : null
    rmSync(CUSTOM_SERVERS_PATH, { force: true })
  })

  afterEach(() => {
    if (customServersBackup == null) {
      rmSync(CUSTOM_SERVERS_PATH, { force: true })
      return
    }
    writeFileSync(CUSTOM_SERVERS_PATH, customServersBackup)
  })

  it("creates and persists a custom remote MCP server", async () => {
    const result = await createCustomRemoteServer({
      name: "custom-test",
      url: "https://example.com/mcp",
      description: "Test MCP",
    })

    expect(result.name).toBe("custom-test")
    expect(result.config).toEqual({
      type: "remote",
      url: "https://example.com/mcp",
      description: "Test MCP",
    })

    const custom = await loadCustomServerConfigs()
    expect(custom["custom-test"]).toEqual(result.config)
  })

  it("merges custom servers into the main server catalog", async () => {
    writeFileSync(CUSTOM_SERVERS_PATH, JSON.stringify({
      "catalog-merge-test": {
        type: "remote",
        url: "https://merge.example/mcp",
        description: "Merged custom MCP",
      },
    }, null, 2))

    const configs = await loadServerConfigs()
    expect(configs["catalog-merge-test"]).toEqual({
      type: "remote",
      url: "https://merge.example/mcp",
      description: "Merged custom MCP",
    })
    // Built-in servers survive the merge...
    expect(configs.granola).toBeDefined()
    // ...except disabled ones, which stay in default.json for their `_note`
    // but are never offered or loadable.
    expect(configs.github).toBeUndefined()
  })
})

/**
 * Tests for buildNotificationManifest — walks .jig/schemas/*.json and filters
 * to tools carrying an annotations.notificationHint.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildNotificationManifest, readNotificationManifest } from "../src/mcp/discover/notification-manifest.js"

let tmp: string
let schemasDir: string
let manifestPath: string

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "jig-nm-"))
  schemasDir = join(tmp, "schemas")
  mkdirSync(schemasDir, { recursive: true })
  manifestPath = join(tmp, "notification-tools.json")
})

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true })
})

function writeSchema(name: string, tools: unknown[]) {
  writeFileSync(join(schemasDir, `${name}.json`), JSON.stringify(tools, null, 2))
}

describe("buildNotificationManifest", () => {
  it("writes an empty manifest when schemas dir is missing", () => {
    rmSync(schemasDir, { recursive: true, force: true })
    const result = buildNotificationManifest(schemasDir, manifestPath)
    expect(result).toEqual([])
    expect(existsSync(manifestPath)).toBe(true)
    expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual([])
  })

  it("writes an empty manifest when no tool carries a notificationHint", () => {
    writeSchema("github", [
      { name: "list_issues", description: "List issues", inputSchema: {}, annotations: { readOnlyHint: true } },
    ])
    const result = buildNotificationManifest(schemasDir, manifestPath)
    expect(result).toEqual([])
  })

  it("collects tools with notificationHint across multiple connections", () => {
    writeSchema("composio", [
      {
        name: "telegram_send_message",
        description: "Send a text message to a Telegram chat\nmore details",
        inputSchema: {},
        annotations: {
          readOnlyHint: false,
          notificationHint: {
            label: "Telegram",
            textField: "text",
            recipientField: "chat_id",
            extraRequired: [],
          },
        },
      },
      {
        name: "telegram_get_me",
        description: "Get me",
        inputSchema: {},
        annotations: { readOnlyHint: true },
      },
    ])
    writeSchema("workspace", [
      {
        name: "gmail_send",
        description: "Send an email",
        inputSchema: {},
        annotations: {
          readOnlyHint: false,
          notificationHint: {
            label: "Gmail",
            textField: "body",
            recipientField: "to",
            extraRequired: ["subject"],
          },
        },
      },
    ])

    const result = buildNotificationManifest(schemasDir, manifestPath)
    expect(result).toHaveLength(2)

    const telegram = result.find((t) => t.tool === "telegram_send_message")!
    expect(telegram.connection).toBe("composio")
    expect(telegram.label).toBe("Telegram")
    expect(telegram.textField).toBe("text")
    expect(telegram.recipientField).toBe("chat_id")
    expect(telegram.description).toBe("Send a text message to a Telegram chat")
    expect(telegram.extraRequired).toEqual([])

    const gmail = result.find((t) => t.tool === "gmail_send")!
    expect(gmail.connection).toBe("workspace")
    expect(gmail.extraRequired).toEqual(["subject"])
  })

  it("merges required schema fields into extraRequired when the hint omits them", () => {
    writeSchema("workspace", [
      {
        name: "gmail_send",
        description: "Send an email",
        inputSchema: {
          type: "object",
          required: ["to", "subject", "body"],
        },
        annotations: {
          readOnlyHint: false,
          notificationHint: {
            label: "Gmail",
            textField: "body",
            recipientField: "to",
            extraRequired: [],
          },
        },
      },
    ])

    const result = buildNotificationManifest(schemasDir, manifestPath)
    expect(result).toHaveLength(1)
    expect(result[0].extraRequired).toEqual(["subject"])
  })

  it("readNotificationManifest returns the file contents", () => {
    writeSchema("composio", [
      {
        name: "telegram_send_message",
        description: "Send",
        inputSchema: {},
        annotations: {
          notificationHint: { label: "Telegram", textField: "text", recipientField: "chat_id", extraRequired: [] },
        },
      },
    ])
    buildNotificationManifest(schemasDir, manifestPath)
    const loaded = readNotificationManifest(manifestPath)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].tool).toBe("telegram_send_message")
  })

  it("skips malformed schema files and continues", () => {
    writeFileSync(join(schemasDir, "broken.json"), "{ not json")
    writeSchema("composio", [
      {
        name: "telegram_send_message",
        description: "Send",
        inputSchema: {},
        annotations: {
          notificationHint: { label: "Telegram", textField: "text", recipientField: "chat_id", extraRequired: [] },
        },
      },
    ])
    const result = buildNotificationManifest(schemasDir, manifestPath)
    expect(result).toHaveLength(1)
  })
})

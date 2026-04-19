/**
 * Derives a notification-capable-tools manifest from cached MCP schemas.
 *
 * Walks every `.jig/schemas/*.json`, filters to tools whose annotations include
 * a notificationHint (set by ensureAnnotations at `jig connect` time), and
 * writes `.jig/notification-tools.json`.
 *
 * The settings UI reads this manifest to let users pick which channels receive
 * failure notifications.
 */
import { join } from "node:path"
import { readdirSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs"
import type { Tool } from "@modelcontextprotocol/sdk/types.js"
import { NOTIFICATION_TOOLS_PATH, SCHEMAS_DIR } from "../../config/paths.js"
import type { NotificationHint } from "../client.js"
import { firstLineSummary } from "../../text.js"

export interface NotificationCapableTool {
  connection: string      // server name, e.g. "composio"
  tool: string            // tool name, e.g. "telegram_send_message"
  label: string           // human-friendly channel name
  description: string     // tool description (first line)
  textField: string
  recipientField: string
  extraRequired: string[]
}

const DEFAULT_MANIFEST_PATH = NOTIFICATION_TOOLS_PATH

export function buildNotificationManifest(
  schemasDir: string = SCHEMAS_DIR,
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): NotificationCapableTool[] {
  const manifest: NotificationCapableTool[] = []

  if (!existsSync(schemasDir)) {
    writeManifest(manifest, manifestPath)
    return manifest
  }

  const files = readdirSync(schemasDir).filter((f) => f.endsWith(".json"))
  for (const file of files) {
    const connection = file.replace(/\.json$/, "")
    let tools: Tool[]
    try {
      tools = JSON.parse(readFileSync(join(schemasDir, file), "utf8")) as Tool[]
    } catch {
      continue
    }
    for (const t of tools) {
      const hint = (t as any).annotations?.notificationHint as NotificationHint | undefined
      if (!hint) continue
      const requiredFields = Array.isArray((t as any).inputSchema?.required)
        ? ((t as any).inputSchema.required as unknown[]).filter((value): value is string => typeof value === "string")
        : []
      const extraRequired = requiredFields.filter(
        (field) => field !== hint.textField && field !== hint.recipientField
      )
      manifest.push({
        connection,
        tool: t.name,
        label: hint.label,
        description: firstLineSummary(t.description),
        textField: hint.textField,
        recipientField: hint.recipientField,
        extraRequired: [...new Set([...(hint.extraRequired ?? []), ...extraRequired])],
      })
    }
  }

  writeManifest(manifest, manifestPath)
  return manifest
}

export function readNotificationManifest(
  manifestPath: string = DEFAULT_MANIFEST_PATH,
): NotificationCapableTool[] {
  if (!existsSync(manifestPath)) return []
  try {
    return JSON.parse(readFileSync(manifestPath, "utf8")) as NotificationCapableTool[]
  } catch {
    return []
  }
}

function writeManifest(manifest: NotificationCapableTool[], manifestPath: string): void {
  mkdirSync(join(manifestPath, ".."), { recursive: true })
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2))
}

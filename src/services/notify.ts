/**
 * Notification service — fires alerts when jigs fail or time out.
 *
 * Driven by:
 *   - `.jig/notification-tools.json` (built at `jig connect` time, lists
 *     every connection+tool that the LLM classified as notification-capable)
 *   - the `notifications` row in the `settings` table (user's chosen
 *     subset + recipients + trigger flags + timeout)
 *
 * Invariants:
 *   - notify() NEVER throws, even with malformed settings or a dead MCP
 *     connection. Callers can fire-and-forget.
 *   - Channels are fanned out with Promise.allSettled so one broken
 *     connection doesn't block the others.
 *   - Sends reuse the generated `.jig/connections/{name}.ts` runtime
 *     modules so proxy tools (e.g. composio) are invoked through the
 *     same path jigs use.
 */
import { join } from "node:path"
import { PROJECT_ROOT } from "../config/paths.js"
import { getSetting, setSetting } from "../db.js"
import { buildNotificationManifest, type NotificationCapableTool } from "../mcp/discover/notification-manifest.js"

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NotificationChannel {
  connection: string                          // server name, e.g. "composio"
  tool: string                                // tool name, e.g. "telegram_send_message"
  recipient: string                           // chat id / email / etc.
  extraParams?: Record<string, unknown>       // e.g. { subject: "Jig alert" }
}

export interface NotificationSettings {
  channels: NotificationChannel[]
  /** Whether to fire on jig run failures. More trigger kinds may land later. */
  triggerOn: { fail: boolean }
}

export interface NotifyReport {
  sent: Array<{ channel: string; ok: true }>
  errors: Array<{ channel: string; error: string }>
}

const SETTINGS_KEY = "notifications"

export const DEFAULT_NOTIFICATION_SETTINGS: NotificationSettings = {
  channels: [],
  triggerOn: { fail: true },
}

// ---------------------------------------------------------------------------
// Settings persistence
// ---------------------------------------------------------------------------

export function getNotificationSettings(): NotificationSettings {
  const raw = getSetting<Partial<NotificationSettings>>(SETTINGS_KEY)
  if (!raw) return { ...DEFAULT_NOTIFICATION_SETTINGS }
  return {
    channels: Array.isArray(raw.channels) ? raw.channels.filter(isValidChannel) : [],
    triggerOn: {
      fail: raw.triggerOn?.fail ?? true,
    },
  }
}

export function saveNotificationSettings(s: NotificationSettings): void {
  setSetting(SETTINGS_KEY, {
    channels: s.channels.filter(isValidChannel),
    triggerOn: { fail: s.triggerOn?.fail ?? true },
  })
}

function isValidChannel(c: unknown): c is NotificationChannel {
  if (!c || typeof c !== "object") return false
  const o = c as Record<string, unknown>
  return typeof o.connection === "string" && typeof o.tool === "string" && typeof o.recipient === "string"
}

// ---------------------------------------------------------------------------
// notify()
// ---------------------------------------------------------------------------

export async function notify(opts: {
  title: string
  body: string
  kind: "fail"
  jigId?: string
  runId?: number
  /** Bypass trigger gating for explicit test sends. */
  ignoreTriggerGate?: boolean
  /** Override for tests — inject a custom tool caller. */
  toolCaller?: (connection: string, tool: string, params: Record<string, unknown>) => Promise<unknown>
  /** Override for tests — supply settings directly instead of reading from DB. */
  settingsOverride?: NotificationSettings
  /** Override for tests — supply manifest directly instead of reading from disk. */
  manifestOverride?: NotificationCapableTool[]
}): Promise<NotifyReport> {
  const report: NotifyReport = { sent: [], errors: [] }

  let settings: NotificationSettings
  try {
    settings = opts.settingsOverride ?? getNotificationSettings()
  } catch (e) {
    console.warn("[notify] failed to load settings:", (e as Error)?.message)
    return report
  }

  if (!opts.ignoreTriggerGate && !settings.triggerOn?.[opts.kind]) return report
  if (!settings.channels?.length) return report

  let manifest: NotificationCapableTool[]
  try {
    manifest = opts.manifestOverride ?? buildNotificationManifest()
  } catch {
    manifest = []
  }
  const manifestIndex = new Map<string, NotificationCapableTool>()
  for (const m of manifest) manifestIndex.set(key(m.connection, m.tool), m)

  const caller = opts.toolCaller ?? defaultToolCaller

  const results = await Promise.allSettled(
    settings.channels.map(async (channel) => {
      const def = manifestIndex.get(key(channel.connection, channel.tool))
      if (!def) {
        throw new Error(
          `Tool "${channel.tool}" on connection "${channel.connection}" is not in the notification manifest. ` +
          `Re-run "jig connect ${channel.connection}" to refresh.`
        )
      }
      const params: Record<string, unknown> = {
        [def.recipientField]: channel.recipient,
        [def.textField]: `${opts.title}\n\n${opts.body}`,
        ...channel.extraParams,
      }
      if (def.extraRequired.includes("subject") && !hasConfiguredValue(params.subject)) {
        params.subject = opts.title
      }
      const result = await caller(channel.connection, channel.tool, params)
      const toolError = extractToolError(result)
      if (toolError) throw new Error(toolError)
      return { channel: labelFor(channel, def) }
    })
  )

  for (let i = 0; i < results.length; i++) {
    const r = results[i]
    const channel = settings.channels[i]
    const def = manifestIndex.get(key(channel.connection, channel.tool))
    const name = labelFor(channel, def)
    if (r.status === "fulfilled") {
      report.sent.push({ channel: name, ok: true })
    } else {
      const err = r.reason
      const msg = err?.message ?? String(err)
      report.errors.push({ channel: name, error: msg })
    }
  }

  return report
}

function key(connection: string, tool: string): string {
  return `${connection}:${tool}`
}

function labelFor(channel: NotificationChannel, def: NotificationCapableTool | undefined): string {
  return def?.label ?? `${channel.connection}.${channel.tool}`
}

function hasConfiguredValue(value: unknown): boolean {
  if (typeof value === "string") return value.trim().length > 0
  return value != null
}

function extractToolError(result: unknown): string | null {
  if (!result || typeof result !== "object" || Array.isArray(result)) return null
  const record = result as Record<string, unknown>
  if (typeof record.error === "string" && record.error.trim()) return record.error.trim()
  return null
}

// ---------------------------------------------------------------------------
// Default tool caller — imports the generated runtime module
// ---------------------------------------------------------------------------

async function defaultToolCaller(
  connection: string,
  tool: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  // Dynamic import so a missing connection file doesn't break startup.
  const modulePath = join(PROJECT_ROOT, ".jig", "connections", `${connection}.ts`)
  const mod = await import(`${modulePath}?_t=${Date.now()}`)
  const fn = (mod as Record<string, unknown>)[tool] as ((p: Record<string, unknown>) => Promise<unknown>) | undefined
  if (typeof fn !== "function") {
    throw new Error(`Generated connection module "${connection}" has no exported tool "${tool}"`)
  }
  return fn(params)
}

// ---------------------------------------------------------------------------
// Body formatter
// ---------------------------------------------------------------------------

export function formatFailureBody(opts: {
  jigId: string
  error: string | null
  startedAt: string | null
  durationMs: number | null
  dashboardBaseUrl?: string
}): string {
  const lines: string[] = []
  if (opts.error) lines.push(`Error: ${opts.error}`)
  if (opts.startedAt) lines.push(`Started: ${opts.startedAt}`)
  if (opts.durationMs != null) {
    const seconds = Math.round(opts.durationMs / 1000)
    const m = Math.floor(seconds / 60)
    const s = seconds % 60
    lines.push(`Duration: ${m}m ${s}s`)
  }
  const base = opts.dashboardBaseUrl ?? `http://localhost:${process.env.JIG_DASHBOARD_PORT ?? "3141"}`
  lines.push(`Link: ${base}/jigs/${opts.jigId}`)
  return lines.join("\n")
}

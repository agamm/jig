# Plan: System notifications for jig failures

**Status:** not started
**Prereq commits landed:** df7f52b..c7a5d6f (ctx.step enforcement, SKILL.md migration, trigger trim, dashboard UX, test hygiene)

---

## Goal

When a jig run fails or times out, send a notification via whatever notification-capable tool the user has connected. The list of candidate tools is **discovered and LLM-classified at `jig connect` time**, reusing the existing annotation pass — not hardcoded, not a new LLM surface. Works for all run sources (manual, cron, webhook, CLI).

This is the #1 trust issue for unattended jigs: if a scheduled digest fails silently, the user finds out days later.

---

## Core insight: extend the existing annotation pass

`src/mcp/client.ts:190` already has `ensureAnnotations(tools)`, which runs ONE batched LLM call at `jig connect` time to classify every tool into `readOnlyHint` and `destructiveHint` and stores the result on the tool's `annotations`. The discovered tools flow through `typegen.ts`, which reads those annotation hints when generating runtime modules.

**We just add a third classification to the same call: `notificationCapable`.**

No new LLM pass, no new cache, no new discovery stage. The existing mechanism:
- Runs once at `jig connect` time
- Covers every tool from every server
- Results are persisted as `tool.annotations` and end up in `.jig/schemas/{server}.json`
- Re-runs of `jig connect` re-annotate

We only need to:
1. Extend the prompt to ask for a third category
2. Extend the annotation shape to carry notification metadata (`textField`, `recipientField`, `label`)
3. Write a small derivation step after annotation: walk the annotated tools, filter `notificationCapable === true`, write `.jig/notification-tools.json`

### Extending `ensureAnnotations`

Current prompt asks for `readOnly` and `destructive`. New prompt asks for a richer JSON per tool:

```typescript
const result = await llm<{
  readOnly: string[]
  destructive: string[]
  notification: Array<{
    name: string
    label: string              // "Telegram", "Gmail", "Slack DM"
    textField: string          // property name in inputSchema for the message body
    recipientField: string     // property name for the destination
    extraRequired: string[]    // other required fields the user must configure
  }>
}>(...)
```

Prompt additions:

```
3. "notification": tools that can SEND a short text alert to a human.
   Examples: telegram_send_message, gmail_send, slack_post_message,
   twilio_send_sms, google_chat_sendDm. NOT drafts, edits, uploads,
   or file sends. For each qualifying tool, include:
     - name: the tool name
     - label: human-friendly channel name (capitalize, drop underscores)
     - textField: the inputSchema property that holds the message body
     - recipientField: the inputSchema property that holds the recipient/destination
     - extraRequired: any other required inputSchema fields the user must
       configure (e.g. "subject" for email)
```

Output shape change is backward compatible for `readOnly`/`destructive` consumers — they read string arrays, the new field is an array of objects under a new key.

### Annotation storage

Each tool's `annotations` gets a new optional field:
```typescript
annotations.notificationHint = {
  label: string
  textField: string
  recipientField: string
  extraRequired: string[]
} | undefined
```

Tools without the hint are not notification-capable. Tools with the hint are candidates for the manifest.

### Manifest derivation

New helper in `src/mcp/discover/notification-manifest.ts`:

```typescript
export function buildNotificationManifest(): NotificationCapableTool[]
```

Walks every `.jig/schemas/*.json`, collects tools whose `annotations.notificationHint` is set, writes `.jig/notification-tools.json`. Called once at the end of `typegen.ts`'s writeConnectionFiles pass, same place we already write schemas.

**Shape:**
```json
[
  {
    "server": "composio",
    "tool": "telegram_send_message",
    "label": "Telegram",
    "description": "Send a text message to a Telegram chat...",
    "textField": "text",
    "recipientField": "chat_id",
    "extraRequired": []
  },
  {
    "server": "workspace",
    "tool": "gmail_send",
    "label": "Gmail",
    "description": "Send an email",
    "textField": "body",
    "recipientField": "to",
    "extraRequired": ["subject"]
  }
]
```

Settings UI reads this. No classifier caching needed beyond what `ensureAnnotations` already does implicitly — it re-runs only at `jig connect`.

---

## Storage — `settings` table

```sql
CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Single row, `key = "notifications"`, `value` is JSON of:

```typescript
export interface NotificationChannel {
  server: string        // "composio"
  tool: string          // "telegram_send_message"
  recipient: string     // "8465930881"
  extraParams?: Record<string, unknown>  // e.g. { subject: "Jig alert" }
}

export interface NotificationSettings {
  channels: NotificationChannel[]
  triggerOn: { fail: boolean; timeout: boolean }
  timeoutMinutes: number            // default 10
}
```

---

## Trigger points (v1)

1. Run ends with `status === "fail"` — all sources
2. Run exceeds `timeoutMinutes` — runner aborts with `error: "Timed out"`
3. NOT on success
4. NOT on skipped runs

---

## File-by-file changes

### Backend

#### `src/db.ts`
- **New migration** (APPEND-ONLY to `MIGRATIONS`):
  ```sql
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
  ```
- Helpers: `getSetting(key)`, `setSetting(key, value)`

#### `src/mcp/client.ts` (`ensureAnnotations` extension)
Extend the prompt and schema to include the `notification` category. Mutate each tool's `annotations.notificationHint` when a match is returned. ~20 lines of change, no new files.

#### `src/mcp/discover/notification-manifest.ts` *(new, ~50 lines)*
```typescript
export function buildNotificationManifest(): NotificationCapableTool[]
export function readNotificationManifest(): NotificationCapableTool[]
```
`buildNotificationManifest` reads every `.jig/schemas/*.json`, filters to tools with `notificationHint`, writes `.jig/notification-tools.json`.

#### `src/mcp/typegen.ts`
At the end of `writeConnectionFiles()`, call `buildNotificationManifest()`. One line.

#### `src/services/notify.ts` *(new, ~120 lines)*
```typescript
export function getNotificationSettings(): NotificationSettings
export function saveNotificationSettings(s: NotificationSettings): void
export async function notify(opts: {
  title: string
  body: string
  kind: "fail" | "timeout"
  jigId: string
  runId: number
}): Promise<{ sent: Array<{ channel: string; ok: true }>; errors: Array<{ channel: string; error: string }> }>
```

Invariants:
- **Never throws.** Every MCP call wrapped in try/catch.
- For each enabled channel, look up the tool in the manifest, build payload using `textField` + `recipientField`:
  ```typescript
  const params = {
    [toolDef.recipientField]: channel.recipient,
    [toolDef.textField]: `${title}\n\n${body}`,
    ...channel.extraParams,
  }
  await callTool(conn, channel.tool, params)
  ```
- Composio tools route through `COMPOSIO_MULTI_EXECUTE_TOOL` — same path the generated `.jig/connections/composio.ts` uses. Reuse `callTool` from `src/mcp/client.ts` directly.
- Multi-channel via `Promise.allSettled`.
- Short-circuit on `channels.length === 0` or `triggerOn[kind] === false`.

Body format:
```
Jig "morning-calendar-telegram" failed

Error: Timed out after 10 minutes
Started: 2026-04-09 08:00:12
Duration: 10m 3s
Link: http://localhost:3000/jigs/morning-calendar-telegram
```

#### `src/services/run-api.ts`
Hook into the finish path inside the async IIFE around line 32:
```typescript
} finally {
  if (skipped) discardTrackedRun(runId)
  else {
    finishTrackedRun(runId)
    const run = runId > 0 ? getRun(runId) : null
    if (run && run.status === "fail") {
      notify({
        title: `Jig "${id}" failed`,
        body: formatFailureBody(run),
        kind: run.error?.includes("Timed out") ? "timeout" : "fail",
        jigId: id,
        runId,
      }).catch(() => {}) // fire-and-forget
    }
  }
}
```

#### `src/runner.ts`
Settings-driven timeout:
```typescript
const timeoutMs = (getNotificationSettings().timeoutMinutes ?? 10) * 60 * 1000
const timeoutHandle = setTimeout(() => signal.abort(new Error("Timed out")), timeoutMs)
try { ... } finally { clearTimeout(timeoutHandle) }
```
Existing `signal` plumbing (used by `cancelActiveRun`) already handles abort.

#### `src/server.ts`
New endpoints:
- `GET /api/settings/notifications` → `{ settings, availableTools }`
- `PUT /api/settings/notifications`
- `POST /api/settings/notifications/test`

#### `shared/api.ts`
Export `NotificationSettings`, `NotificationChannel`, `NotificationCapableTool`.

### Frontend

#### `dashboard/src/app/settings/page.tsx`
**Check first:** `find dashboard/src -name "settings*" -o -path "*settings*"`. Extend if exists, create if not.

#### `dashboard/src/components/notifications-settings.tsx` *(new)*
- **Channels** section: lists every `availableTools` entry with checkbox + recipient input + any `extraRequired` fields. Empty state: "No notification-capable tools detected. Run `jig connect <server>` to add one."
- **Trigger on**: fail / timeout checkboxes
- **Timeout minutes**: number input (default 10)
- **Save** / **Send test** buttons

#### `dashboard/src/lib/api.ts` + `swr.ts`
Fetchers + `useNotificationSettings` hook.

### Tests

#### `test/ensure-annotations.test.ts` *(new or extended)*
Mock the LLM call. Verify:
1. Prompt includes the notification category
2. `notification` array from LLM response is applied as `annotations.notificationHint`
3. Tools not in the notification list get no hint
4. Existing readOnly/destructive behaviour unchanged

#### `test/notification-manifest.test.ts` *(new)*
Given synthetic `.jig/schemas/*.json` with `notificationHint` annotations, `buildNotificationManifest()` writes the expected `.jig/notification-tools.json`. Temp-dir based.

#### `test/notify.test.ts` *(new)*
Mock MCP client. ~8 tests:
1. Empty channels → no calls, empty report
2. `triggerOn.fail === false` on fail event → no calls
3. Single telegram channel → `callTool` invoked with correct payload shape
4. Single gmail channel → correct `to`/`body`/`subject` construction
5. Multi-channel → `Promise.allSettled`, partial success reported
6. Tool missing from manifest → recorded as error, other channels still fire
7. Malformed settings JSON in DB → empty channels, warning logged
8. `notify()` never throws even with a broken connection

#### `test/db.test.ts`
Round-trip test for `getSetting`/`setSetting`.

#### `test/notifications-api.test.ts` *(new)*
Server integration: PUT → GET → test-send (mocked MCP).

---

## Commit breakdown

Each commit leaves `bun test && bunx tsc --noEmit` green.

1. **`db: add settings table and get/setSetting helpers`**
2. **`mcp: classify notification-capable tools in ensureAnnotations pass`**
   - Extend prompt + annotation shape in `client.ts`
   - Add `buildNotificationManifest()` and wire into typegen
   - Tests
3. **`services: add notify() helper driven by manifest + settings`**
4. **`runner: add per-run timeout (settings-driven, default 10 min)`**
5. **`run-api: fire notify() on run failure and timeout`**
6. **`server: expose notification settings endpoints`**
7. **`dashboard: notifications section in settings page`**

---

## Open questions to resolve in session 1

1. **Does a settings page exist?** Run `find dashboard/src -name "settings*"` first.
2. **Prefill Gmail recipient from connected account?** If `workspace` exposes an account-info tool, auto-fill; otherwise empty.
3. **Annotation persistence across jig start?** Check whether `ensureAnnotations` runs on every `jig start` or only on `jig connect`. If only on connect, existing users need to re-run `jig connect` once after this lands. If on every start, no action needed. (Most likely connect-only based on the "Called once during jig connect" comment.)
4. **Fallback when LLM returns no `notification` field?** Treat as empty list. Don't crash. Log a warning.
5. **Timeout override path?** v1 global. Per-jig deferred.
6. **Test notification content?** `title: "Jig test notification"`, `body: "If you see this, notifications are working."`

---

## Non-goals / deferred

- Per-jig notification overrides
- Notification history / inbox view
- Success notifications
- Rate limiting / dedup
- Web push / PWA
- Per-user label overrides (LLM-derived only in v1)

---

## Definition of done

- [ ] All 7 commits landed, tests green after each
- [ ] Type check clean
- [ ] `.jig/notification-tools.json` auto-generated on next `jig connect`, contains at least telegram and gmail
- [ ] Settings page lists tools dynamically, user can pick subset + recipients
- [ ] Manual: failing jig → notification arrives via chosen channel
- [ ] Manual: jig with `while(true)` → timeout notification fires
- [ ] Zero new external dependencies (no Resend / Twilio / npm)
- [ ] All sends reuse existing MCP connections

---

## Context for a fresh session

Read in order:
1. This plan (`tasks/plan-notifications.md`)
2. `src/mcp/client.ts` — `ensureAnnotations` at line 190 is where the classification extension lives
3. `src/mcp/typegen.ts` — `writeConnectionFiles()` is where the manifest build hooks in
4. `src/services/run-api.ts` — run finish path, primary notify() hook
5. `src/runner.ts` — run lifecycle, timeout hook
6. `src/db.ts` — migration pattern (APPEND-ONLY to `MIGRATIONS` array)
7. `.jig/schemas/composio.json` + `.jig/schemas/workspace.json` — real schemas to verify the classifier output
8. `.jig/connections/composio.ts` — reference for how composio tools are called via the proxy
9. `CLAUDE.md` — conventions

### Key invariants to preserve

- **Runner never crashes on notification failure.** `notify.ts` never throws; callers also `.catch(() => {})`.
- **Migrations are append-only.**
- **Settings in SQLite, secrets in `.env`.**
- **No new OAuth surface.**
- **No new LLM pass.** Extend `ensureAnnotations` — don't add a parallel classifier.
- **No hardcoded channel assumptions.** Slack, Discord, SMS, etc. must work without code changes.
- **Re-running `jig connect` is idempotent.** Classification results overwrite prior annotations.

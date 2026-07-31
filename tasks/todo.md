# Remove MCP-tool notification channels — AgentMail is the only alert path (2026-07-30)

Failure alerts could ride a connected MCP tool (Telegram, Gmail, Google Chat)
picked from an LLM-classified manifest. That path is structurally unreliable for
its own job: the most common jig failure *is* a connection losing auth, so the
alert about the broken connection went out over the broken connection. Deleted
it. AgentMail — a direct HTTPS send, independent of MCP — is now the only path,
and the "Notify on failures" switch moved into the AgentMail card.

## Implementation — all complete
- [x] **Deleted** `src/mcp/discover/notification-manifest.ts`,
  `test/notification-manifest.test.ts`,
  `dashboard/src/components/notifications-settings.tsx`
- [x] **Annotation pass** (`src/mcp/client.ts`): dropped the `notification`
  category from the `ensureAnnotations` prompt/schema/write-back, the
  `NotificationHint` type, the schema-hints block, and the keyword fallback in
  `inferToolAnnotations`. `readOnlyHint` / `destructiveHint` untouched.
- [x] **Typegen** (`src/mcp/typegen.ts`): removed the manifest derivation step;
  `NOTIFICATION_TOOLS_PATH` gone from `src/config/paths.ts` + reset handler
- [x] **`src/services/notify.ts`**: rewritten as an AgentMail-only alerter.
  `notify()` → `Promise<boolean>`, gated on `notifyOnFailure`, keeps the
  reply-token/thread-recording path. Channels, manifest, tool caller, health,
  and test-status all removed. `formatFailureBody()` unchanged.
- [x] **`src/services/agentmail.ts`**: `notifyOnFailure` added to settings +
  status + save; falls back to the legacy `notifications.triggerOn.fail` row so
  upgrades don't silently re-enable alerts someone had paused
- [x] **Server**: `/api/settings/notifications` + `/test` routes deleted;
  `agentMailSettings` PUT accepts `notifyOnFailure`
- [x] **Shared contracts**: all seven `Notification*` / `NotifyTestResponse`
  types + their two `ApiContracts` entries removed; `notifyOnFailure` added to
  the AgentMail response/update
- [x] **Dashboard**: toggle + paused notice in `agentmail-settings.tsx` (saves
  on click — one boolean, and Save is gated on key+email), card chrome moved
  into the component, dead `compact` prop and write-only `webhookReady` state
  removed; shell renders `<AgentMailSettings />` for the notifications tab
- [x] **Tests**: `test/notify.test.ts` rewritten against the AgentMail surface
  (9 cases incl. the legacy-paused-flag carry-over);
  `test/notifications-routes.test.ts` → `test/settings-routes.test.ts`, now
  asserting the agentmail routes resolve and the removed ones don't
- [x] Version bump 0.1.78 → 0.1.79 (both `package.json` files)

## Verification done
- `bunx tsc --noEmit`: zero errors in `src/`, `shared/`, `test/` (remaining
  errors are pre-existing generated `.jig/connections/*` + user `jigs/*`)
- `bun test`: 395 pass / 3 fail — the same 3 failures (`validate.test.ts` ×2,
  `custom server configs` ×1) reproduce on a stashed clean tree
- `pnpm run build` in `dashboard/`: compiled + typechecked clean
- Live server: `GET /api/settings/agentmail` returns `notifyOnFailure`; both
  removed routes 404; PUT round-trips the flag and a PUT of `owner` alone does
  not clobber it
- Live UI: Settings → Notifications is one card with the toggle in its header,
  no connection list; toggling persists across reload
- `jig start` typegen ran with no manifest step; a real scheduled failure
  (apify auth expired) went through the new `notify()` with no error

## Notes / follow-ups
- `.jig/notification-tools.json` is left on existing installs — inert, nothing
  reads it, and `.jig/` is local state.
- `legacyNotifyOnFailure()` in `agentmail.ts` is deletable once no live DB
  predates this change.

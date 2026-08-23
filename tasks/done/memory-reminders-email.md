# Persistent memory for jigs

Goal: a jig can remember things across runs, wake itself at an arbitrary future
time, and receive data by email. Target use case: a to-do jig you email items to,
which reminds you when each is due.

Three primitives, built in dependency order.

## Findings (verified before building)

- No cross-run state exists. `SKILL.md:428` states it outright. Only
  `calendar_fires` is stateful, and the scheduler owns it, not jigs.
- Triggers are `cron | manual | webhook | calendar` (`src/domain/jig-source.ts:5`).
  None expresses "once, at 3pm Thursday".
- Inbound mail routes by `thread_id` -> `email_threads` -> the jig's *authoring
  agent*. So replying "buy milk" to a jig email tries to rewrite the jig's code.
  A brand-new email has no thread row and is dropped at gate 4 in
  `services/email-inbound.ts`.
- AgentMail supports named per-jig inboxes: `POST /v0/inboxes` takes `username`,
  `domain`, `client_id`, `metadata`; `inbox_id` is the address itself.
- jig's existing webhook (`agentmail.ts:182`) is registered org-wide (no
  `inbox_ids`), so new inboxes need NO webhook change. `inbox_ids` is capped at
  10/webhook, so inbox-scoped webhooks would have broken at 10 email jigs.
- `message.received` payload carries `message.inbox_id` -> the router key.
- Plus-addressing is not documented anywhere in the AgentMail docs. Not used.
- `cli.ts:501` does not pass `jigId` into `runJig`, so CLI runs have no jig
  identity in ctx. Pre-existing `ctx.email` bug; blocks memory. Fix it.

## 1. `ctx.memory` - persistent per-jig KV

- [x] `jig_memory(jig_id, key, value, updated_at)` table in `SCHEMA` + migration
- [x] db.ts accessors: get/set/delete/list/count/clear
- [x] Caps: value bytes + keys per jig, throw a clear error past them
- [x] `ctx.memory` on Context, scoped to `jigId`
- [x] Dry-run: reads pass through, writes no-op with an output line
- [x] Fix `cli.ts` to pass `jigId` (blocker)
- [x] Clear memory when a jig is archived

## 2. `ctx.remind` - self-scheduled wake-ups

- [x] `jig_reminders(id, jig_id, key, due_at, payload, created_at, fired_at)`
      table + migration, partial indexes for due lookup and key uniqueness
- [x] db.ts accessors: schedule/list-due/mark-fired/cancel/list-pending/prune
- [x] Reminder pass in `scheduler/tick.ts`, mirroring the calendar pass:
      injected deps, record-before-fire, one jig's failure cannot stop others
- [x] Batch all of a jig's due reminders into ONE run -> `ctx.params.reminders`
      (avoids one-per-tick serialization and N separate emails)
- [x] Skip (do not consume) when a run is already in flight for that jig
- [x] `ctx.remind(at, payload, {key})`, `ctx.reminders()`, `ctx.cancelReminder(key)`
- [x] Prune fired reminders in daily maintenance
- [x] Clear reminders when a jig is archived

## 3. Email-in - a router address per jig

- [x] `jig_inboxes(jig_id, inbox_id, address, created_at)` table + migration
- [x] `{ type: "email" }` trigger in `jig-source.ts` + `schedules.trigger_type`
- [x] Provision the inbox on schedule sync; handle `resource_taken` on username
      collision (suffix, then fall back to AgentMail-generated)
- [x] Route inbound by `message.inbox_id`: jig-owned inbox -> run the jig with
      `ctx.params.email`; otherwise fall through to existing authoring routing
- [x] Keep the owner-only From gate (mail reaching `message.received` has already
      passed SPF/DKIM/DMARC per AgentMail's own classification)
- [x] `ctx.email()` sends from the jig's own inbox when it has one, so replies
      come back as data rather than as authoring edits

## 4. Surfacing + docs

- [x] `shared/api.ts` types; server endpoints for memory + reminders
- [x] Dashboard: per-jig memory and reminders view (inspect + delete)
- [x] SKILL.md: document all three, plus a worked to-do jig example
- [x] Version bump in both package.json files

## 5. Tests

- [x] memory: caps, jig scoping, dry-run write no-op
- [x] reminders: due selection, batching, record-before-fire, active-run skip
- [x] email routing: inbox -> jig, non-owner rejected, unknown inbox falls through
- [x] db: fresh and migrated databases converge

## Review

All three shipped. 595 tests pass (up from 529), both typechecks clean.

### What was built

- `ctx.memory` — `jig_memory` table, per-jig scoping, 64KB/value and 1000-key
  caps, dry-run writes no-op while reads stay live.
- `ctx.remind` / `ctx.reminders()` / `ctx.cancelReminder()` — `jig_reminders`
  table with partial indexes over pending rows only. New `reminder-tick.ts`
  pass on the existing 60s tick, mirroring `calendar-tick.ts`.
- `{ type: "email" }` trigger — `jig_inboxes` table, per-jig AgentMail inbox
  provisioned on sync, inbound routing by `message.inbox_id` ahead of thread
  routing. `ctx.email()` now sends from a jig's own inbox when it has one, so
  replies come back as data rather than as authoring edits.
- Dashboard: Memory pane (inspect, delete a key, clear all, cancel a reminder)
  and the jig's email address with a copy button.
- SKILL.md: all three documented, plus a worked to-do jig that was run through
  the real validator (ok, no errors).

### Decisions worth remembering

- **Reminders batch per jig per tick.** Only one run per jig can be active, so
  firing one run per reminder would stretch a batch across as many minutes as
  there are reminders and send N emails where the user expected one list.
  `ctx.params.reminders` is therefore always an array.
- **Claim-before-run**, matching `calendar-tick.ts`. A crash mid-tick costs one
  missed reminder; claim-after would resend on every tick until one survived.
  `markJigRemindersFired` uses `RETURNING id` so the tick fires exactly the
  reminders it won, never the ones it merely asked for.
- **A paused jig holds its reminders** rather than consuming them, so
  re-enabling delivers what came due instead of silently dropping it.
- **Webhooks stay org-wide.** `inbox_ids` caps at 10 per webhook, so
  inbox-scoped webhooks would have broken at the 11th email jig. The existing
  registration already had no filter, so per-jig inboxes needed no change there.
- **No reply token on the data path.** A token guards *edits*; this path only
  hands text to a jig that opted into receiving mail. The real gate is that we
  subscribe only to `message.received`, which AgentMail has already put through
  SPF/DKIM/DMARC — so the owner match is on authenticated mail.

### Fixed along the way

- `cli.ts` never passed `jigId` into `runJig`, so CLI runs got a context with no
  jig identity. That silently broke `ctx.email`'s reply-to-edit wiring already
  and would have broken memory. One-line fix; CLI runs now match the scheduler.
- `SKILL.md` said "Jigs have no cross-run state" and "the three types" of
  trigger. Both were true when written and are not now.

### Not done

- `stripQuotedReply()` in `email-inbound.ts` hand-rolls what AgentMail's
  `extracted_text` field already does (Talon, ~94% accuracy per their docs).
  The new data path uses `extracted_text`; the older authoring path still uses
  the hand-rolled version. Worth unifying, but out of scope here.
- No UI to *add* a memory entry by hand. Read and delete only — a jig writes,
  the user inspects and corrects.

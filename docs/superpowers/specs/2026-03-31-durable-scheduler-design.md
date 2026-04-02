# Durable Scheduler

## Overview

SQLite-backed cron scheduler embedded in `jig start`. Survives process crashes, catches up missed runs on restart, exposes webhook endpoints. Uses `croner` for cron math.

## Triggers

| Trigger | Mechanism |
|---------|-----------|
| `cron` | 60s tick loop, `croner` computes next run |
| `webhook` | HTTP route `/api/webhooks/:jigId`, fires run on POST |
| `manual` | Not scheduled |
| Event-like | Use cron + `ctx.skip()` in jig code |

## Data Model

**New table: `schedules`**

- `jig_id` TEXT PK
- `entity` TEXT PK (empty string for single-instance)
- `trigger_type` TEXT (`cron` or `webhook`)
- `cron_expr` TEXT (nullable, for cron only)
- `missed_strategy` TEXT (`catch-up` default, or `skip`)
- `next_run_at` INTEGER (nullable, unix timestamp)
- `last_run_at` INTEGER (nullable, unix timestamp)
- `enabled` INTEGER (1 = active, 0 = paused)

## SDK Addition

`ctx.skip(reason?)` — short-circuits the handler. Run is NOT persisted to SQLite, does NOT appear in dashboard. It's a no-op.

## Trigger Config Extension

```typescript
{ type: "cron", cron: "0 9 * * 5", missedStrategy?: "catch-up" | "skip" }  // default: catch-up
{ type: "webhook" }
```

## Components

### `src/scheduler/index.ts`
Exports `startScheduler()` called from `server.ts` after boot. Runs sync → recover → start tick loop.

### `src/scheduler/sync.ts`
On startup (and jig file changes), scan jigs via `discoverJigs()`, read trigger configs, reconcile with `schedules` table:
- New cron jig → insert, compute `next_run_at`
- Changed cron → update and recompute
- Deleted jig or changed to manual → remove row
- Webhook jigs → ensure row exists (no `next_run_at`)

### `src/scheduler/tick.ts`
`setInterval` every 60s:
- Query `schedules WHERE trigger_type = 'cron' AND enabled = 1 AND next_run_at <= now()`
- Fire `runJig()` non-blocking for each due jig
- Update `next_run_at` to next occurrence, set `last_run_at`
- Skip if jig already running (check run-store)

### `src/scheduler/recover.ts`
Runs once at startup after sync:
- Missed cron runs (`next_run_at < now()`):
  - `catch-up`: fire once immediately, advance to next future occurrence
  - `skip`: just advance to next future occurrence
- Interrupted runs (stuck in `running` status): mark as `fail` with error `"interrupted by process restart"`

### `src/scheduler/webhooks.ts`
Register `/api/webhooks/:jigId` routes for webhook-triggered jigs. On POST: validate jig exists, fire `runJig()`, return 202.

## Dashboard Changes

- Jig list: show next scheduled run time for cron jigs
- Jig detail: schedule info (next run, last run, enabled toggle, missed strategy)
- Skipped runs don't appear anywhere

## Not Building

- No distributed locking (single process)
- No retry logic (run once, fail = fail)
- No notification sinks beyond dashboard (future)
- No step-level resumption
- No second-level precision

## New Dependency

`croner` — cron expression parsing, next occurrence computation. Zero deps, works in Bun.

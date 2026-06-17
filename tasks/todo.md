# Reply-to-edit jig emails via AgentMail (2026-06-17)

Reply to a jig's failure email in plain English → the authoring agent applies the
edit and ships it. Channel is AgentMail (free `@agentmail.to` inbox, no DNS), not
Resend inbound. Threaded back-and-forth for clarification; auto-approve on ship;
jig-failure emails route through AgentMail while connection/system alerts stay on
Resend.

## Implementation — all complete
- [x] **DB**: v17 migration `email_threads` (thread_id → jig_id + agent_session_id)
  + `recordEmailThread` / `getEmailThread` / `setEmailThreadSession` (`src/db.ts`)
- [x] **Service** `src/services/agentmail.ts`: settings/credential accessors,
  idempotent `setupAgentMail` (inbox + webhook via `client_id`), `sendAgentMailEmail`,
  `replyAgentMail`, inline Svix HMAC `verifyAgentMailWebhook` (no SDK)
- [x] **Outbound**: `notify()` sends fail emails via AgentMail when configured +
  records thread; Resend fallback. `getNotificationHealth` counts either email
  channel (`src/services/notify.ts`)
- [x] **Inbound** `src/services/email-inbound.ts`: Svix verify → exact
  `message.received` → owner match → known thread → start/continue session
- [x] **Bridge** `src/services/email-agent-bridge.ts`: subscribes to session
  frames; ask_user→reply question, draft/edit→auto-approve+reply, error→reply.
  `agent-service.ts` exports `subscribeToSessionFrames` + `autoApproveSession`
  (validates the pending with `checkJigFile` before shipping)
- [x] **Server**: `/api/email/inbound` (raw body, public via Svix) +
  `/api/settings/agentmail` GET/PUT/setup/test (`router.ts`, `server.ts`,
  `lock-middleware.ts`)
- [x] **Dashboard**: `agentmail-settings.tsx` + `lib/api.ts` helpers + shared
  types, mounted in notifications settings; version bump 0.1.41 → 0.1.42

## Verification done
- Migration on a **copy of the real DB** (v16→v17): table + columns created,
  helpers (insert/upsert/set-session/miss) correct
- Svix verify cross-checked against Svix's **published test vector** (scheme
  matches) + e2e (valid/tampered/stale/missing/multi-sig)
- Reply-stripping (Gmail/Outlook) + owner-address parsing unit-checked
- `bunx tsc --noEmit` clean for all changed files (27 pre-existing errors in
  generated `.jig/connections/*` + user `jigs/*` only); dashboard tsc 0 errors
- `bun test`: 371 pass; the only 2 failures (`validate.test.ts`) are pre-existing
  on clean `main`

## Notes / follow-ups
- **Prereq for the user**: set `JIG_PUBLIC_URL` (publicly reachable) before
  "Connect inbox" — AgentMail must reach `/api/email/inbound`. Surfaced in the
  setup handler error + UI copy.
- Security: Svix signature + exact `message.received` (AgentMail handles
  SPF/DKIM/DMARC; `.spam`/`.blocked`/`.unauthenticated` dropped) + owner match.
- Not done: full `next build` (heavy) — typecheck only. No automated test added
  for the inbound/bridge flow (logic verified via inline scripts); worth adding a
  `test/email-inbound.test.ts` later.

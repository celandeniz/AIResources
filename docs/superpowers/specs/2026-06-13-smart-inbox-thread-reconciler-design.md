# Smart Inbox — Thread Reconciler (supersede AI drafts when a human replies)

**Date:** 2026-06-13
**Status:** Approved design — ready for implementation plan
**Area:** services/api (DynamicsOps AI Resource Platform)

## Problem

When a customer email arrives, an AI Resource drafts a reply that waits in the
Approval Center (draft-first). If the owner (Deniz) or a DynamicsOps team member
replies to that thread **themselves**, the pending AI draft becomes redundant —
but today it stays in the queue and could be approved/sent as a duplicate.

We want the platform to recognise "this thread has been handled by a human" and
automatically **supersede** (cancel) the pending AI reply-draft for that thread.

## Goal & success criteria

- When owner or a team member (`@WATCH_TEAM_DOMAIN`) replies in a thread that has a
  pending AI **reply** approval, that approval is auto-cancelled and the activity
  advanced — no duplicate reply is sent.
- Internal (non-reply) actions for the same thread are preserved.
- Never wrongly cancel: on any uncertainty (no thread id, Graph error) the draft
  is left untouched (fail-safe).
- Visible/auditable: owner gets a lightweight notification; cancelled approvals
  carry a clear reason and remain queryable.

## Decisions (from brainstorming)

1. **Trigger:** owner **or** team member (`@dynamicsops.com`) replying in the thread.
   Customer re-replies are out of scope for v1.
2. **Action on match:** cancel only the **reply-message** approvals
   (`send_email`, `send_proposal`, `send_whatsapp_message`, `send_teams_message`,
   `post_message`); keep internal actions (e.g. `create_task`, `create_ticket`);
   advance the activity.
3. **Detection:** a **periodic thread reconciler** that checks each pending
   reply-approval's thread via Microsoft Graph (reusing the existing
   `GraphEmailAdapter.fetchConversationReplies`). Chosen over on-ingest because
   owner/team replies usually land in Sent Items, not the polled inbox.
4. **Structure:** a dedicated single-purpose `ThreadReconcilerService` (approach A),
   modelled on `email-watch.service.ts`, independent of email-watch's
   park/escalate concern; reuses the Graph conversation query rather than
   duplicating it.

## Architecture

New unit: `services/api/src/integrations/thread-reconciler.service.ts`
(`@Injectable`, registered in the integrations module; mirrors `email-watch.service.ts`).

Public surface (the rest is private):
- `reconcileOnce(): Promise<{ scanned: number; superseded: number }>` — one full
  pass across active workspaces; called by the tick and by the manual trigger.
- `reconcileApproval(approvalId): Promise<boolean>` — reconcile a single approval
  (used by tests / targeted calls).

Internally it depends on: `PrismaService`, `GraphEmailAdapter`
(`fetchConversationReplies`), `graphConfigured()`, `tenantStore`, `AuditService`,
and the stream-event emitter.

## Data flow (per tick, per active workspace inside `tenantStore.run`)

1. **Collect candidates** — `approvals` where:
   - `status = 'pending'`
   - `action ∈ MESSAGE_ACTIONS`
     (`send_email, send_proposal, send_whatsapp_message, send_teams_message, post_message`)
   - related `activity.channel = 'email'`
   - `activity.metadata.conversation_id` is present
   - `approval.created_at < now − THREAD_RECONCILER_GRACE_MS` (grace window)
   - ordered oldest-first, capped at ~50 per tick.
2. **Check the thread** — resolve the live (`is_mock=false`) `graph_email`
   connection (matched to the activity's source integration if present, else the
   first live one); call
   `fetchConversationReplies(conn, mailbox, conversation_id, sinceISO = activity.received_at)`.
3. **Human reply?** — see predicate below. First matching reply → supersede.
4. **Supersede** — cancel the activity's pending reply-approvals, preserve internal
   actions, advance the activity, audit, notify, emit stream event.

## Detection predicate

`isHumanReply(reply, ctx)` is true iff **all** hold:
1. `lower(reply.from) ∈ OWNER_EMAILS` **or** `domain(reply.from) === WATCH_TEAM_DOMAIN`;
2. `lower(reply.from) !== lower(ctx.originalSender)` where
   `originalSender = activity.metadata.from` (the customer) — never count the
   customer's own messages;
3. `reply.at > ctx.sinceISO` (`sinceISO = activity.received_at`).
   `fetchConversationReplies` already applies the time filter.

`OWNER_EMAILS` (comma list; falls back to `WATCH_OWNER_EMAIL`) and
`WATCH_TEAM_DOMAIN` are the existing env values.

**Why the AI's own sent reply never causes a false supersede:** only **pending**
approvals are scanned. While pending, the AI has not sent anything, so any
owner/team message in the thread is a genuine human reply. Once an approval is
approved+sent, its status is no longer `pending`, so it is not scanned.

## On-match action

For the matched **activity**:
1. Set every pending `MESSAGE_ACTIONS` approval → `status='cancelled'`,
   `decided_at=now`, `reviewer_id=null` (system),
   `decision_notes = "Superseded: <from> replied in thread (<at>)"`.
   Set the linked `tool_call.status='cancelled'` so the executor never runs it.
2. Leave non-message approvals (`create_task`, `create_ticket`, …) pending.
3. Advance the activity using the existing `advanceActivity` semantics: if no
   pending approvals remain → `status='completed'`, `completed_at=now`. Always
   set `metadata.superseded_by_human = { by, at }`.
4. Write an `audit_logs` entry per cancelled approval
   ("Superseded: human replied in thread").
5. Emit **one** lightweight `notifications` row to the owner, type
   `draft_superseded`: "AI taslağı iptal edildi — '<subject>' thread'ine <from> yanıt verdi."
6. `emitStreamEvent({ type: 'approval', ... })` so the Approval Center removes the
   card live.

**Visibility:** cancelled approvals drop off the default (pending) list, carry
`decision_notes`, and are discoverable via the Approval Center status filter
(`cancelled`), the audit log, and the notification. No new UI in v1.

## Scheduling, manual trigger, config

- **Tick:** `onModuleInit` — if `graphConfigured()`, `setInterval(reconcileOnce,
  THREAD_RECONCILER_TICK_MS)` plus a one-shot ~30s after boot. Gated by
  `ENABLE_THREAD_RECONCILER`. Idle when Graph is unconfigured.
- **Manual:** the existing **"Kaynaktan çek"** action (`POST /sources/sync`) also
  runs `reconcileOnce()` after pulling sources (one click = pull new mail +
  supersede handled threads). Also expose `POST /sources/reconcile` for
  explicitness and testing (on the existing `SourcesController`).
- **Config (docker-compose api `environment`):**
  - `ENABLE_THREAD_RECONCILER` (default `true`)
  - `THREAD_RECONCILER_TICK_MS` (default `600000` — 10 min)
  - `THREAD_RECONCILER_GRACE_MS` (default `120000` — 2 min)
  - reuses `OWNER_EMAILS` / `WATCH_OWNER_EMAIL` and `WATCH_TEAM_DOMAIN`.

## Error handling (fail-safe — never wrongly cancel)

- **No `conversation_id`** → skip the candidate.
- **Graph error / mailbox unreachable** → log, leave the approval pending.
- **No live `graph_email` connection** → reconciler idle.
- **Grace window** → only approvals older than `THREAD_RECONCILER_GRACE_MS` are
  considered (avoid racing a just-created draft or same-tick ingestion).
- **Idempotent** → re-check `status='pending'` immediately before updating;
  a second pass is a no-op.
- **Tenant isolation** → per active workspace via `tenantStore.run`; only that
  workspace's mailbox + approvals.
- **Per-tick cap** (~50) to bound Graph calls.

## Scope / non-goals (v1)

- Email threads only (`conversation_id`). Teams/WhatsApp threads → future.
- Trigger is owner/team only. A **customer** re-replying in the thread is NOT
  handled here (future: auto-redraft with the new context).
- No new UI; superseded items visible via the existing status filter + audit +
  notification.
- Does not change email-watch's park/escalate behavior.

## Testing & verification

- **Unit:**
  - `isHumanReply(reply, ctx)` — owner match, team-domain match, exclude original
    sender, time gate.
  - candidate filter — pending + message action + email + `conversation_id` +
    grace window.
- **Integration (controllable, inject `fetchConversationReplies`):** seed a pending
  `send_email` approval whose activity has a known `conversation_id` +
  `received_at`, then:
  - (a) a team-domain reply after `received_at` → approval `cancelled`, activity
    advanced, notification emitted, internal action (if any) preserved;
  - (b) only the customer's own later message → **no change**;
  - (c) `fetchConversationReplies` throws → **no change** (fail-safe);
  - (d) second run → no-op (idempotent).
- **Live smoke:** on a real thread, create a pending draft, reply from a
  `@dynamicsops.com` address, click "Kaynaktan çek" → the card disappears
  (cancelled) and a notification appears.

## Files (anticipated)

- **New:** `services/api/src/integrations/thread-reconciler.service.ts`.
- **Modified:** the integrations module (register service + its tick;
  `SourcesController` gains `POST /sources/reconcile` and `/sources/sync` calls
  `reconcileOnce()`); `docker-compose.yml` (3 env vars).
- **Reused (unchanged):** `GraphEmailAdapter.fetchConversationReplies`,
  `email-watch.service.ts` (pattern reference only), `OWNER_EMAILS` /
  `WATCH_TEAM_DOMAIN` config, `approval_status` enum (`cancelled` already exists).

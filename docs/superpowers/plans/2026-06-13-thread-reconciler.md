# Smart Inbox — Thread Reconciler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-cancel a pending AI reply-draft when the owner or a team member replies in that email thread, so no duplicate reply is sent.

**Architecture:** A single-purpose `ThreadReconcilerService` (api, modelled on `email-watch.service.ts`) runs on a timer + on manual "Kaynaktan çek". Per active workspace it scans pending reply-approvals, checks each one's thread via the existing `GraphEmailAdapter.fetchConversationReplies`, and if an owner/team reply newer than the inbound message exists, cancels the reply-approval(s), preserves internal actions, advances the activity, and notifies. Fail-safe: any uncertainty (no thread id, Graph error) leaves the draft untouched.

**Tech Stack:** NestJS (services/api), Prisma/Postgres, Microsoft Graph (app-only), Docker Compose. Spec: `docs/superpowers/specs/2026-06-13-smart-inbox-thread-reconciler-design.md`.

> **Verification note (repo reality):** services/api has **no unit-test framework** (scripts are only `build`/`typecheck`/`lint`). This plan therefore verifies the way every feature in this repo is verified: `tsc --noEmit` typecheck, Docker build, a `node` assertion against compiled `dist/` for the pure predicate, and live `curl` checks against the running API. Do **not** add jest/vitest — it is out of scope.

---

## File Structure

- **Create** `services/api/src/integrations/thread-reconciler.service.ts` — the service + exported pure helper `isHumanReply` + `ThreadReply` type. One responsibility: supersede pending reply-drafts when a human replied. Reuses `fetchConversationReplies`; owns its tick.
- **Modify** `services/api/src/modules/approvals/approvals.service.ts` — `export` the existing `MESSAGE_ACTIONS` constant so the reconciler reuses it (DRY).
- **Modify** `services/api/src/integrations/ingestion.poller.ts` — register `ThreadReconcilerService` in `IngestionModule`; inject it into `SourcesController`; add `POST /sources/reconcile`; have `POST /sources/sync` also run `reconcileOnce()`.
- **Modify** `docker-compose.yml` — add `ENABLE_THREAD_RECONCILER`, `THREAD_RECONCILER_TICK_MS`, `THREAD_RECONCILER_GRACE_MS` to the `api` service env.

---

## Task 1: Export `MESSAGE_ACTIONS` from approvals.service

**Files:**
- Modify: `services/api/src/modules/approvals/approvals.service.ts:12`

- [ ] **Step 1: Add `export` to the constant**

Change line 12 from:

```ts
const MESSAGE_ACTIONS = ['send_email', 'send_proposal', 'send_whatsapp_message', 'send_teams_message', 'post_message'];
```

to:

```ts
export const MESSAGE_ACTIONS = ['send_email', 'send_proposal', 'send_whatsapp_message', 'send_teams_message', 'post_message'];
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @dynops/api typecheck`
Expected: exits 0, no errors (the existing in-file usage still resolves).

- [ ] **Step 3: Commit**

```bash
git add services/api/src/modules/approvals/approvals.service.ts
git commit -m "refactor(approvals): export MESSAGE_ACTIONS for reuse"
```

---

## Task 2: Create `ThreadReconcilerService` (service + pure predicate)

**Files:**
- Create: `services/api/src/integrations/thread-reconciler.service.ts`

- [ ] **Step 1: Write the full service file**

Create `services/api/src/integrations/thread-reconciler.service.ts` with exactly this content:

```ts
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { GraphEmailAdapter } from './graph/graph-email.adapter';
import { graphConfigured } from './graph/graph-client';
import { tenantStore } from '../common/tenant';
import { emitStreamEvent } from '../common/events';
import { MESSAGE_ACTIONS } from '../modules/approvals/approvals.service';

// Addresses the OWNER sends from; a reply from any of these (or any team-domain
// address) means a human on our side handled the thread.
const OWNER_EMAILS = (process.env.OWNER_EMAILS ?? process.env.WATCH_OWNER_EMAIL ?? 'deniz@dynamicsops.com')
  .split(',')
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);
const TEAM_DOMAIN = (process.env.WATCH_TEAM_DOMAIN ?? 'dynamicsops.com').toLowerCase();
const ENABLED = process.env.ENABLE_THREAD_RECONCILER !== 'false';
const TICK_MS = Number(process.env.THREAD_RECONCILER_TICK_MS ?? 600000); // 10 min
const GRACE_MS = Number(process.env.THREAD_RECONCILER_GRACE_MS ?? 120000); // 2 min
const MAX_PER_TICK = 50;

export interface ThreadReply {
  from: string;
  at: string;
}

// PURE: is this conversation reply from a human on our side (owner or team),
// not the original customer, and newer than the inbound message? No I/O — unit-testable.
export function isHumanReply(
  reply: ThreadReply,
  ctx: { ownerEmails: string[]; teamDomain: string; originalSender: string; sinceISO: string },
): boolean {
  const from = (reply?.from ?? '').toLowerCase();
  if (!from) return false;
  const isOwner = ctx.ownerEmails.includes(from);
  const isTeam = from.endsWith(`@${ctx.teamDomain}`);
  if (!isOwner && !isTeam) return false;
  if (from === (ctx.originalSender ?? '').toLowerCase()) return false; // never the customer
  return (reply.at ?? '') > ctx.sinceISO;
}

@Injectable()
export class ThreadReconcilerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ThreadReconcilerService');
  private readonly email = new GraphEmailAdapter();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (!ENABLED) {
      this.logger.log('Thread reconciler disabled (ENABLE_THREAD_RECONCILER=false).');
      return;
    }
    if (!graphConfigured()) {
      this.logger.log('Graph not configured — thread reconciler idle.');
      return;
    }
    this.logger.log(`Thread reconciler active (tick every ${TICK_MS}ms, grace ${GRACE_MS}ms).`);
    this.timer = setInterval(() => this.reconcileOnce().catch((e) => this.logger.error(e.message)), TICK_MS);
    setTimeout(() => this.reconcileOnce().catch((e) => this.logger.error(e.message)), 30000);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  // One full pass across all live graph_email workspaces.
  async reconcileOnce(): Promise<{ scanned: number; superseded: number }> {
    let scanned = 0;
    let superseded = 0;
    if (!graphConfigured()) return { scanned, superseded };
    const live = await this.prisma.integrations.findMany({ where: { is_mock: false, type: 'graph_email' } });
    for (const row of live) {
      const mailbox = (row.config as any)?.mailbox || (row.config as any)?.external_ref || '';
      if (!mailbox) continue;
      const conn = { id: row.id, type: row.type, name: row.name, config: (row.config as any) ?? {}, isMock: row.is_mock };
      try {
        await tenantStore.run({ workspaceId: row.workspace_id ?? undefined }, async () => {
          const r = await this.processWorkspace(row.workspace_id ?? undefined, conn, mailbox);
          scanned += r.scanned;
          superseded += r.superseded;
        });
      } catch (e) {
        this.logger.warn(`reconcile tick failed for ${row.name}: ${(e as Error).message}`);
      }
    }
    return { scanned, superseded };
  }

  private async processWorkspace(wsId: string | undefined, conn: any, mailbox: string) {
    const graceThreshold = new Date(Date.now() - GRACE_MS);
    const candidates = await this.prisma.approvals.findMany({
      where: {
        status: 'pending',
        action: { in: MESSAGE_ACTIONS as any },
        created_at: { lt: graceThreshold },
        workspace_id: wsId,
      },
      orderBy: { created_at: 'asc' },
      take: MAX_PER_TICK,
      include: {
        activity: { select: { id: true, subject: true, channel: true, metadata: true, received_at: true, created_at: true } },
      },
    });
    let scanned = 0;
    let superseded = 0;
    const seenActivities = new Set<string>();
    for (const ap of candidates) {
      const act = ap.activity as any;
      if (!act || act.channel !== 'email') continue;
      if (seenActivities.has(act.id)) continue; // one supersede per activity per tick
      const conversationId = (act.metadata as any)?.conversation_id ?? null;
      if (!conversationId) continue;
      seenActivities.add(act.id);
      scanned++;
      const did = await this.reconcileActivity(act, conn, mailbox, conversationId, wsId);
      if (did) superseded++;
    }
    return { scanned, superseded };
  }

  // Check one activity's thread; if a human replied, supersede its reply-drafts.
  // Returns true if it superseded. Fail-safe: Graph errors return false (leave pending).
  private async reconcileActivity(
    act: any,
    conn: any,
    mailbox: string,
    conversationId: string,
    wsId: string | undefined,
  ): Promise<boolean> {
    const originalSender = String((act.metadata as any)?.from ?? '').toLowerCase();
    const sinceISO = (act.received_at ?? act.created_at).toISOString();
    let replies: ThreadReply[] = [];
    try {
      replies = await this.email.fetchConversationReplies(conn, mailbox, conversationId, sinceISO);
    } catch (e) {
      this.logger.warn(`reconcile: fetchConversationReplies failed for activity ${act.id}: ${(e as Error).message}`);
      return false; // fail-safe: leave the draft pending
    }
    const human = replies.find((r) =>
      isHumanReply(r, { ownerEmails: OWNER_EMAILS, teamDomain: TEAM_DOMAIN, originalSender, sinceISO }),
    );
    if (!human) return false;
    return this.supersedeActivity(act, human, wsId);
  }

  // Cancel pending reply-message approvals for the activity; preserve internal
  // actions; advance the activity; audit + notify + stream. Idempotent.
  private async supersedeActivity(act: any, human: ThreadReply, wsId: string | undefined): Promise<boolean> {
    const pendingMsgApprovals = await this.prisma.approvals.findMany({
      where: { activity_id: act.id, status: 'pending', action: { in: MESSAGE_ACTIONS as any } },
      include: { tool_call: { select: { id: true } } },
    });
    if (!pendingMsgApprovals.length) return false;
    const note = `Superseded: ${human.from} replied in thread (${human.at})`;
    for (const ap of pendingMsgApprovals) {
      await this.prisma.approvals.update({
        where: { id: ap.id },
        data: { status: 'cancelled', decided_at: new Date(), reviewer_id: null, decision_notes: note },
      });
      if ((ap as any).tool_call?.id) {
        await this.prisma.tool_calls.update({ where: { id: (ap as any).tool_call.id }, data: { status: 'cancelled' } });
      }
      await this.prisma.audit_logs.create({
        data: {
          workspace_id: wsId,
          actor_type: 'system',
          action: 'route',
          entity_type: 'approvals',
          entity_id: ap.id,
          activity_id: act.id,
          summary: note,
        },
      });
      emitStreamEvent({ type: 'approval', workspaceId: wsId, payload: { id: ap.id, status: 'cancelled' } });
    }
    const remaining = await this.prisma.approvals.count({ where: { activity_id: act.id, status: 'pending' } });
    const meta = (act.metadata as any) ?? {};
    await this.prisma.activities.update({
      where: { id: act.id },
      data: {
        ...(remaining === 0 ? { status: 'completed', completed_at: new Date() } : {}),
        metadata: { ...meta, superseded_by_human: { by: human.from, at: human.at } },
      },
    });
    await (this.prisma as any).notifications.create({
      data: {
        workspace_id: wsId,
        type: 'draft_superseded',
        title: 'AI taslağı iptal edildi',
        message: `'${act.subject ?? '(konusuz)'}' thread'ine ${human.from} yanıt verdi — bekleyen AI taslağı iptal edildi.`,
        metadata: { activityId: act.id },
      },
    });
    this.logger.log(`reconcile: superseded ${pendingMsgApprovals.length} draft(s) for activity ${act.id} (human: ${human.from})`);
    return true;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @dynops/api typecheck`
Expected: exits 0. (If it complains that `MESSAGE_ACTIONS` is not exported, Task 1 was skipped — do Task 1 first.)

- [ ] **Step 3: Commit**

```bash
git add services/api/src/integrations/thread-reconciler.service.ts
git commit -m "feat(api): ThreadReconcilerService — supersede AI drafts when a human replies"
```

---

## Task 3: Register the service + wire SourcesController (tick + manual triggers)

**Files:**
- Modify: `services/api/src/integrations/ingestion.poller.ts` (imports; `SourcesController`; `IngestionModule`)

- [ ] **Step 1: Import the reconciler**

At the top of `services/api/src/integrations/ingestion.poller.ts`, add this import next to the existing imports:

```ts
import { ThreadReconcilerService } from './thread-reconciler.service';
```

- [ ] **Step 2: Inject the reconciler into `SourcesController` + add endpoints**

Replace the existing `SourcesController` class body so it injects the reconciler, runs it on sync, and exposes a dedicated reconcile endpoint. The current class is:

```ts
@Controller('sources')
class SourcesController {
  constructor(private readonly poller: IngestionPoller) {}

  @Get()
  list() {
    return this.poller.listSources();
  }

  @Roles('consultant')
  @Post('sync')
  sync() {
    return this.poller.syncNow();
  }
}
```

Replace it with:

```ts
@Controller('sources')
class SourcesController {
  constructor(
    private readonly poller: IngestionPoller,
    private readonly reconciler: ThreadReconcilerService,
  ) {}

  @Get()
  list() {
    return this.poller.listSources();
  }

  // Pull latest from sources AND supersede threads a human already answered.
  @Roles('consultant')
  @Post('sync')
  async sync() {
    const synced = await this.poller.syncNow();
    const reconciled = await this.reconciler.reconcileOnce();
    return { ...synced, reconciled };
  }

  // Run only the thread reconciler (supersede handled threads) on demand.
  @Roles('consultant')
  @Post('reconcile')
  reconcile() {
    return this.reconciler.reconcileOnce();
  }
}
```

- [ ] **Step 3: Register the provider in `IngestionModule`**

The current module is:

```ts
@Module({
  imports: [InboxModule],
  controllers: [SourcesController],
  providers: [IngestionPoller],
})
export class IngestionModule {}
```

Replace it with:

```ts
@Module({
  imports: [InboxModule],
  controllers: [SourcesController],
  providers: [IngestionPoller, ThreadReconcilerService],
})
export class IngestionModule {}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @dynops/api typecheck`
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add services/api/src/integrations/ingestion.poller.ts
git commit -m "feat(api): wire ThreadReconciler into IngestionModule + /sources/{sync,reconcile}"
```

---

## Task 4: Config — env vars on the api service

**Files:**
- Modify: `docker-compose.yml` (api `environment`)

- [ ] **Step 1: Add the env vars**

In `docker-compose.yml`, under the `api:` service `environment:` block, find the existing `OWNER_EMAILS:` line (added for the owner-reply skip) and add these three lines immediately after it:

```yaml
      # Thread reconciler — supersede pending AI reply-drafts once a human
      # (owner/team) replies in the thread. Empty/true = on; needs Graph live.
      ENABLE_THREAD_RECONCILER: ${ENABLE_THREAD_RECONCILER:-true}
      THREAD_RECONCILER_TICK_MS: ${THREAD_RECONCILER_TICK_MS:-600000}
      THREAD_RECONCILER_GRACE_MS: ${THREAD_RECONCILER_GRACE_MS:-120000}
```

- [ ] **Step 2: Validate compose**

Run: `docker compose config >/dev/null && echo OK`
Expected: prints `OK` (no YAML error).

- [ ] **Step 3: Commit**

```bash
git add docker-compose.yml
git commit -m "chore(compose): thread-reconciler env (enable/tick/grace)"
```

---

## Task 5: Build + unit-check the pure predicate against compiled dist

**Files:**
- (no source change) build output `services/api/dist/integrations/thread-reconciler.service.js`

- [ ] **Step 1: Build the api image (compiles TS → dist)**

Run: `docker compose build api`
Expected: ends with `Image dynops-node:local Built` (no TS errors).

- [ ] **Step 2: Unit-check `isHumanReply` against the compiled module**

This repo has no test runner, so verify the pure predicate by requiring the compiled CommonJS from a one-off Node assertion (the same technique used for `detectSystemEmail`). Run from repo root:

```bash
node -e '
const path = require("path");
const mod = require("./services/api/dist/integrations/thread-reconciler.service.js");
const { isHumanReply } = mod;
const assert = require("assert");
const ctx = { ownerEmails: ["deniz@dynamicsops.com"], teamDomain: "dynamicsops.com", originalSender: "dana@contoso.com", sinceISO: "2026-06-13T10:00:00.000Z" };
// owner reply after inbound → human
assert.strictEqual(isHumanReply({ from: "deniz@dynamicsops.com", at: "2026-06-13T11:00:00.000Z" }, ctx), true, "owner after");
// team member reply after inbound → human
assert.strictEqual(isHumanReply({ from: "ekip@dynamicsops.com", at: "2026-06-13T11:00:00.000Z" }, ctx), true, "team after");
// the customer themselves → NOT human
assert.strictEqual(isHumanReply({ from: "dana@contoso.com", at: "2026-06-13T11:00:00.000Z" }, ctx), false, "customer excluded");
// external third party → NOT human
assert.strictEqual(isHumanReply({ from: "someone@other.com", at: "2026-06-13T11:00:00.000Z" }, ctx), false, "external excluded");
// owner reply BEFORE the inbound (older) → not after sinceISO → false
assert.strictEqual(isHumanReply({ from: "deniz@dynamicsops.com", at: "2026-06-13T09:00:00.000Z" }, ctx), false, "before inbound");
// empty from → false
assert.strictEqual(isHumanReply({ from: "", at: "2026-06-13T11:00:00.000Z" }, ctx), false, "empty from");
console.log("isHumanReply: ALL 6 ASSERTIONS PASSED");
'
```

Expected output: `isHumanReply: ALL 6 ASSERTIONS PASSED` (exit 0). If the require path differs, locate it with `find services/api/dist -name "thread-reconciler.service.js"` and use that path.

- [ ] **Step 3: Commit (no code change — this step gates progress; nothing to commit)**

No commit. If Step 2 failed, fix `isHumanReply` in `thread-reconciler.service.ts`, rebuild, re-run.

---

## Task 6: Deploy + live verification (routes, reconcile pass, fail-safe)

**Files:** (no source change)

- [ ] **Step 1: Deploy the rebuilt api**

```bash
docker compose up -d api
```
Then wait for readiness:
```bash
for i in $(seq 1 40); do curl -fsS -X POST http://localhost:4000/api/v1/auth/dev-login -H 'content-type: application/json' -d '{"email":"manager@dynamicsops.com","role":"manager"}' >/dev/null 2>&1 && { echo ready; break; }; sleep 3; done
```
Expected: prints `ready`.

- [ ] **Step 2: Confirm the reconciler started + routes mapped**

```bash
docker compose logs api 2>&1 | grep -iE "Thread reconciler active|RouterExplorer.*sources/reconcile" | tail
```
Expected: a line `Thread reconciler active (tick every 600000ms, grace 120000ms).` and `Mapped {/api/v1/sources/reconcile, POST} route`.

- [ ] **Step 3: Trigger a reconcile pass (no-op safe on current data)**

```bash
TOKEN=$(curl -fsS -X POST http://localhost:4000/api/v1/auth/dev-login -H 'content-type: application/json' -d '{"email":"manager@dynamicsops.com","role":"manager"}' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
curl -fsS -X POST http://localhost:4000/api/v1/sources/reconcile -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;d=json.loads(sys.stdin.read());print("scanned:",d.get("scanned"),"superseded:",d.get("superseded"))'
```
Expected: prints `scanned: <N> superseded: <M>` (HTTP 200; values are whatever the current data yields — the point is the endpoint runs without error). `/sources/sync` should also now return a `reconciled` field — verify:
```bash
curl -fsS -X POST http://localhost:4000/api/v1/sources/sync -H "authorization: Bearer $TOKEN" | python3 -c 'import sys,json;d=json.loads(sys.stdin.read());print("reconciled:",d.get("reconciled"))'
```
Expected: prints `reconciled: {'scanned': ..., 'superseded': ...}`.

- [ ] **Step 4: Controllable end-to-end check (supersede a real pending draft)**

This proves the full path. Ingest a customer email, let the worker draft a `send_email` (pending approval), then simulate the owner replying in that thread and reconcile.

> **Grace window:** candidates must be older than `THREAD_RECONCILER_GRACE_MS` (default 2 min). For an immediate check, first redeploy with grace disabled so the fresh approval is eligible:
> ```bash
> THREAD_RECONCILER_GRACE_MS=0 docker compose up -d api
> ```
> (Re-run the readiness wait from Step 1.) Restore the default afterward with a plain `docker compose up -d api`.

```bash
TOKEN=$(curl -fsS -X POST http://localhost:4000/api/v1/auth/dev-login -H 'content-type: application/json' -d '{"email":"manager@dynamicsops.com","role":"manager"}' 2>/dev/null | python3 -c 'import sys,json;print(json.load(sys.stdin)["accessToken"])')
CONV="recon-test-conv-$(date +%s)"
# 1) ingest a customer email with a known conversation_id
ACT=$(curl -fsS -X POST http://localhost:4000/api/v1/activities/ingest -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d "{\"channel\":\"email\",\"external_id\":\"recon-$(date +%s)\",\"from\":\"dana@contoso.com\",\"subject\":\"Destek: e-fatura\",\"body\":\"Merhaba, e-fatura hatasi icin doner misiniz?\",\"conversation_id\":\"$CONV\"}" | python3 -c 'import sys,json;print(json.load(sys.stdin)["activityId"])')
echo "activity=$ACT conv=$CONV"
# 2) wait for a pending send_email approval
for i in $(seq 1 40); do sleep 5; AID=$(docker compose exec -T postgres psql -U dynops -d dynops -t -A -c "SELECT id FROM approvals WHERE activity_id='$ACT' AND action='send_email' AND status='pending' LIMIT 1;" 2>/dev/null | tr -d ' \r'); [ -n "$AID" ] && { echo "approval=$AID"; break; }; done
```

Now the reconciler needs the owner's reply to appear in the live mailbox thread `$CONV`. Two ways to verify:

- **(a) Real smoke (preferred):** from a `@dynamicsops.com` account, reply in the actual Outlook thread whose conversationId matches the ingested mail, then run `POST /sources/reconcile`. (Only works when the ingested mail is a real thread; for the synthetic `$CONV` above, use option b.)
- **(b) Deterministic check of the supersede mutation:** temporarily force the reply by seeding the Graph result is not possible without Graph; instead verify the **non-supersede fail-safe** with the synthetic thread: run reconcile and confirm the approval is **still pending** (no real owner reply exists for `$CONV`, and `fetchConversationReplies` returns none or errors → fail-safe leaves it):

```bash
curl -fsS -X POST http://localhost:4000/api/v1/sources/reconcile -H "authorization: Bearer $TOKEN" >/dev/null
docker compose exec -T postgres psql -U dynops -d dynops -c "SELECT status FROM approvals WHERE id='$AID';"
```
Expected: `status = pending` (fail-safe: no human reply found → draft preserved). This confirms the reconciler does NOT cancel without a confirmed human reply.

- [ ] **Step 5: Verify the cancel path with a unit-level mutation check (predicate already proven in Task 5)**

The supersede DB mutation (`supersedeActivity`) is exercised by Task 5's predicate (decision) + the live no-op (Step 4b shows it correctly does nothing without a reply). For positive confirmation of the cancel itself, do the real smoke in Step 4a on a genuine thread and confirm:

```bash
docker compose exec -T postgres psql -U dynops -d dynops -c "SELECT a.status, a.decision_notes FROM approvals a WHERE a.id='<AID-from-real-thread>';"
```
Expected after a real owner/team reply + reconcile: `status = cancelled`, `decision_notes` starting with `Superseded:`; and a `notifications` row of type `draft_superseded` exists:
```bash
docker compose exec -T postgres psql -U dynops -d dynops -c "SELECT type,title FROM notifications WHERE type='draft_superseded' ORDER BY created_at DESC LIMIT 1;"
```
Expected: one `draft_superseded` row.

- [ ] **Step 6: Final commit (verification notes only — no code change)**

No source change in Task 6. If any step revealed a bug, fix it in `thread-reconciler.service.ts`, rebuild (`docker compose build api && docker compose up -d api`), and re-run the failing step, then:
```bash
git add -A && git commit -m "fix(api): thread-reconciler verification fixes" # only if a fix was needed
```

---

## Done criteria

- `tsc --noEmit` clean; api image builds.
- `isHumanReply` passes all 6 assertions (Task 5).
- `POST /sources/reconcile` and `POST /sources/sync` (with `reconciled`) return 200; "Thread reconciler active" logged.
- Fail-safe verified: a pending draft with no confirmed human reply stays `pending`.
- Real-thread smoke: owner/team reply → approval `cancelled` + `draft_superseded` notification + activity advanced.
- All commits landed on `main` (matching repo convention).

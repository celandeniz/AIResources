# DynOps Mobile — M2 Chat-first Assistant Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship M2 of the DynOps Mobile app — a chat-first assistant: talk to any active AI resource from the phone (text + voice input), see threads, and have any tool intent the agent proposes flow through the existing draft-first approval pipeline. Replaces the `Sohbet — M2'de geliyor` placeholder tab shipped in M1, per the approved spec `docs/superpowers/specs/2026-06-14-mobile-app-design.md` (§2, §3.2).

**Architecture:** `POST /api/v1/chat` generalizes the Teams bot's `/ask <resource-key> <question>` command (`services/api/src/modules/teams/teams.controller.ts`) into a first-class REST endpoint. The api calls the agent **directly and synchronously** — `fetch(`${AGENT_URL}/v1/agents/run`)` with `x-internal-token` — the same pattern already used in `teams.controller.ts`, `analyst.controller.ts`, `approvals.service.ts` (regenerate/propose-time), and `status-reports/synthesize.ts`. This is the established "hybrid seam" for any request that needs an agent reply in the same HTTP round-trip (no queue, no polling). Each chat thread is one `activities` row with `channel='chat'`; each turn (user message + assistant reply) is two `messages` rows on that activity — mirroring how every other channel already works, so the existing inbox/activity plumbing (audit, tenant scoping, `messages` timeline) applies for free. Any `tool_intents` the agent proposes are turned into `tool_calls` + `approvals` rows using the exact same gate logic as `services/worker/src/process-activity.ts` (§4) — chat never bypasses draft-first.

**Tech stack:** Backend: NestJS + Prisma (existing), no new npm deps. Mobile: Flutter, flutter_riverpod, go_router (existing) + two new packages: `speech_to_text` (STT) and `flutter_tts` (optional TTS toggle).

## Design decision: how the api gets a synchronous chat reply

**Investigated:** two candidate approaches.
1. *Route chat through the worker's BullMQ queue* (`QueueService.enqueueActivity`), then poll/SSE-wait for the resulting draft message. This is how every *inbound* channel (email, Teams, DevOps…) works today, but it's built for fire-and-forget async processing — the api would need a new "wait for this activity's next outbound message" mechanism that doesn't exist, adding a moving part.
2. **Call the agent directly from the api controller** (`fetch(AGENT_URL + '/v1/agents/run', ...)` with `x-internal-token: INTERNAL_TOKEN`), the same way `teams.controller.ts`'s `/ask` command, `analyst.controller.ts`'s `/analyst/ask`, and `approvals.service.ts`'s regenerate/propose-time flows already do. The api then does the tool_calls/approvals bookkeeping itself (same pattern as `code-tasks.controller.ts`'s approval-gated `code_task` creation, which builds `agent_runs` → `tool_calls` → `approvals` directly from a controller, no worker involved).

**Chosen: (2).** It is already the dominant, repeated pattern in `services/api/src` for any endpoint that needs a same-request agent answer, it needs zero new infrastructure, and `AgentDraftSchema.kind` in `packages/shared/src/agent.ts` already has a `'chat_reply'` variant reserved — a strong signal this was anticipated. The chat controller will:
- Build an `AgentRunRequest` inline (resource's system_prompt/model/tools, `activity.channel: 'chat'`, `context.thread` = prior messages on this thread activity for continuity).
- Call the agent, get `{draft, tool_intents, confidence, needs_escalation}`.
- Persist the user message + assistant reply as `messages` rows.
- Replicate the worker's tool-intent gate (§4 of `process-activity.ts`): create a `tool_calls` row per intent; if `sensitive`/`needs_escalation`/`confidence < threshold`/`over approval_limit`, also create a pending `approvals` row (chat never auto-executes sensitive tools) and set the thread activity to `awaiting_approval`; otherwise auto-execute low-risk intents via the existing `ExecutorService`/`executeToolCallViaApi`-equivalent path.

## Global Constraints

- All mobile API calls send `Authorization: Bearer <jwt>` + `x-workspace: <workspace-id>` headers (existing `ApiClient` in `apps/mobile/lib/core/api.dart` — no changes needed to the client itself).
- Tenant scoping: the chat controller relies on `TenantMiddleware` (`services/api/src/common/tenant.middleware.ts`) — read `currentWorkspaceId()` from `services/api/src/common/tenant.ts`, never trust a client-supplied workspace id in the body.
- Draft-first is non-negotiable: **no** tool intent from chat may execute without going through the same `requires_approval` gate as the worker (sensitive tool OR `needs_escalation` OR `confidence < resource.confidence_threshold` OR monetary amount over `resource.approval_limit`). Reuse `TOOL_REGISTRY` from `@dynops/shared` for `sensitive`/`risk`/`monetary` lookups.
- Fail-closed / audit: every chat turn writes an `audit_logs` row via `AuditService` (`services/api/src/common/audit.service.ts`), same as every other write path in this repo.
- Backend verification: `pnpm --filter @dynops/db build` (regenerates the Prisma client so the new `chat` enum value is typed — **required**, unlike model-only additions which use `(prisma as any)`) then `pnpm --filter @dynops/api typecheck` must exit 0; live checks via curl + `docker compose exec postgres psql`.
- Flutter verification: `flutter analyze` (no errors) + `flutter test` (all pass) inside `apps/mobile`.
- Flutter toolchain: Flutter is installed at `~/development/flutter` — export `PATH="$HOME/development/flutter/bin:$PATH"` before any `flutter` command in a fresh shell. `apps/mobile/build` may need its existing `/tmp` symlink (repo sits under iCloud Drive, which chokes on Flutter's build-directory churn) — do not delete/recreate that symlink; if `flutter build`/`flutter run` complains about `build/`, verify the symlink still points into `/tmp` before troubleshooting further.
- Git: this repo's working tree lives under iCloud Drive, which can stall git's fsync/rename on commit. Commit with `git commit --no-verify -c commit.gpgsign=false -m "…"` for `apps/mobile` changes in this plan **only if a plain `git commit` stalls or fails** — try the plain form first; fall back to the flags only on observed failure, and never use them to skip a *failing* hook (only to route around the iCloud filesystem stall). Backend (`services/api`, `packages/db`) commits are unaffected and use the normal commit flow.
- Do not modify `emitStreamEvent` call sites outside this plan's new code; the chat endpoint may emit its own `activity`-type stream events (optional, Task 2) but must not touch other emitters.
- `POST /api/v1/chat` is a normal authenticated endpoint (JWT Bearer, no `@Public()`, no bot-secret gate) — unlike the Teams bot's `/ask`, this is a first-party mobile client route.
- Voice input is device-side only (Flutter `speech_to_text` plugin using the OS's on-device/cloud STT) — the transcribed text is sent to the existing `POST /chat` endpoint exactly as if typed; no new backend audio endpoint.

---

## Task 1: Backend — `chat` activity_channel enum + Prisma client regen

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (`activity_channel` enum, ~line 41)
- Modify: `packages/shared/src/enums.ts` (`ACTIVITY_CHANNELS` array, for TS-side consistency — note: `mission` was never added here either, so this is a nice-to-have consistency fix, not a hard requirement, but do it since `chat` is user-facing from mobile and worth typing correctly)

**Interfaces:**
- Consumes: nothing new.
- Produces: `activity_channel` enum value `'chat'` usable in typed `prisma.activities.create({ data: { channel: 'chat', ... } })` calls (Task 2 depends on this — without the regen, `channel: 'chat'` fails to typecheck).

- [ ] **Step 1: Add the enum value**

In `packages/db/prisma/schema.prisma`, add `chat` to the `activity_channel` enum (after `whatsapp`, the last precedent addition):

```prisma
enum activity_channel {
  email
  teams
  calendar
  devops
  github
  opsconnect
  business_central
  crm
  erp
  sharepoint
  ticket
  document
  manual
  proactive
  mission
  whatsapp
  chat
}
```

- [ ] **Step 2: Add to the shared TS enum (consistency)**

In `packages/shared/src/enums.ts`, add `'chat'` to `ACTIVITY_CHANNELS`:

```ts
export const ACTIVITY_CHANNELS = [
  'email',
  'teams',
  'calendar',
  'devops',
  'github',
  'opsconnect',
  'business_central',
  'crm',
  'erp',
  'sharepoint',
  'ticket',
  'document',
  'manual',
  'whatsapp',
  'chat',
] as const;
```

- [ ] **Step 3: Regenerate the Prisma client + build shared**

Run:
```bash
pnpm --filter @dynops/shared build
pnpm --filter @dynops/db build
```
Expected: both exit 0 (`db build` runs `prisma generate && tsc`, picking up the new `chat` enum value into the generated client's TS types).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @dynops/api typecheck`
Expected: exit 0 (no chat code exists yet — this just confirms the enum regen didn't break anything).

- [ ] **Step 5: Apply schema to the running DB (if stack is up)**

```bash
docker compose up -d postgres
pnpm --filter @dynops/db push
```
Expected: `The database is already in sync with the Prisma schema` or a successful alter (Postgres enums gain a value via `ALTER TYPE … ADD VALUE`, non-destructive, no data loss — `db push --accept-data-loss` is safe here since only a value is being added, not removed).

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/schema.prisma packages/shared/src/enums.ts
git commit -m "feat(db): add chat to activity_channel enum for M2 mobile chat"
```

---

## Task 2: Backend — `POST /api/v1/chat` (synchronous agent reply + thread persistence)

**Files:**
- Create: `services/api/src/modules/chat/chat.controller.ts` (single-file controller+@Module, mirrors `missions.controller.ts` / `code-tasks.controller.ts`)
- Modify: `services/api/src/app.module.ts` (import + register `ChatModule`)

**Interfaces:**
- Consumes: `PrismaService`, `AuditService`, `AuthUser`/`CurrentUser` (`services/api/src/auth/decorators`), `currentWorkspaceId()` (`services/api/src/common/tenant`), `TOOL_REGISTRY`/`isKnownTool` (`@dynops/shared`), `AgentRunRequest` (`@dynops/shared`), `emitStreamEvent` (`services/api/src/common/events`).
- Produces: `POST /api/v1/chat {resource_key: string, message: string, thread_id?: string}` → `{thread_id, reply: string, tool_intents_pending: boolean}`. Task 3 (`GET /chat/threads`) and Task 4 (`GET /chat/threads/:id/messages`) read the `activities`/`messages` rows this creates. Task 6 (mobile) is the sole consumer of all three endpoints.

- [ ] **Step 1: Create the chat controller**

Create `services/api/src/modules/chat/chat.controller.ts`:

```ts
import { BadRequestException, Body, Controller, Get, Module, Param, Post } from '@nestjs/common';
import type { AgentRunRequest } from '@dynops/shared';
import { TOOL_REGISTRY, isKnownTool } from '@dynops/shared';
import { PrismaService } from '../../prisma/prisma.service';
import { AuditService } from '../../common/audit.service';
import { emitStreamEvent } from '../../common/events';
import { currentWorkspaceId } from '../../common/tenant';
import { CurrentUser, AuthUser } from '../../auth/decorators';

// ── Mobile chat (M2) ─────────────────────────────────────────────────────────
// Generalizes the Teams bot's `/ask <resource> <question>` (teams.controller.ts)
// into a first-class REST endpoint: talk to any active AI resource, get a
// synchronous reply, keep a thread. Each thread = one activities row with
// channel='chat'; each turn = two messages rows (inbound user, outbound AI).
// Tool intents the agent proposes are gated exactly like the worker
// (process-activity.ts §4) — chat NEVER auto-executes a sensitive/low-confidence
// tool call; it lands in the normal Approval Center instead.
const AGENT_URL = process.env.AGENT_URL ?? 'http://localhost:8000';
const INTERNAL_TOKEN = process.env.INTERNAL_TOKEN ?? 'dev-internal-token';

async function runChatAgent(req: AgentRunRequest): Promise<any> {
  const res = await fetch(`${AGENT_URL}/v1/agents/run`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-internal-token': INTERNAL_TOKEN },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`agent ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return res.json();
}

@Controller('chat')
class ChatController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  @Get('threads')
  async threads(@CurrentUser() user: AuthUser) {
    const wsId = currentWorkspaceId();
    const rows = await this.prisma.activities.findMany({
      where: { channel: 'chat', ...(wsId ? { workspace_id: wsId } : {}) },
      orderBy: { updated_at: 'desc' },
      take: 100,
      include: {
        assigned_resource: { select: { id: true, key: true, name: true } },
        messages: { orderBy: { created_at: 'desc' }, take: 1 },
      },
    });
    return rows.map((a) => ({
      id: a.id,
      subject: a.subject,
      status: a.status,
      resource: a.assigned_resource ? { id: a.assigned_resource.id, key: a.assigned_resource.key, name: a.assigned_resource.name } : null,
      last_message: a.messages[0]?.body ?? null,
      last_message_at: a.messages[0]?.created_at ?? a.updated_at,
      updated_at: a.updated_at,
    }));
  }

  @Get('threads/:id/messages')
  async threadMessages(@Param('id') id: string) {
    const activity = await this.prisma.activities.findUnique({ where: { id } });
    if (!activity || activity.channel !== 'chat') throw new BadRequestException('chat thread not found');
    const messages = await this.prisma.messages.findMany({
      where: { activity_id: id },
      orderBy: { created_at: 'asc' },
    });
    return {
      thread: { id: activity.id, subject: activity.subject, status: activity.status, resource_id: activity.assigned_resource_id },
      messages: messages.map((m) => ({
        id: m.id,
        direction: m.direction,
        author_type: m.author_type,
        body: m.body,
        is_draft: m.is_draft,
        created_at: m.created_at,
      })),
    };
  }

  @Post()
  async send(@Body() body: { resource_key: string; message: string; thread_id?: string }, @CurrentUser() user: AuthUser) {
    const message = body?.message?.trim();
    if (!message) throw new BadRequestException('message is required');
    const wsId = currentWorkspaceId();

    // Resolve or create the thread activity.
    let activity = body.thread_id
      ? await this.prisma.activities.findUnique({ where: { id: body.thread_id } })
      : null;
    if (activity && activity.channel !== 'chat') throw new BadRequestException('thread_id is not a chat thread');

    const resource = activity?.assigned_resource_id
      ? await this.prisma.ai_resources.findUnique({ where: { id: activity.assigned_resource_id } })
      : await this.prisma.ai_resources.findFirst({
          where: { OR: [{ key: body.resource_key }, { name: { contains: body.resource_key ?? '', mode: 'insensitive' } }], status: 'active' },
        });
    if (!resource) throw new BadRequestException(`No active resource matching "${body.resource_key}".`);

    if (!activity) {
      activity = await this.prisma.activities.create({
        data: {
          workspace_id: wsId,
          channel: 'chat',
          subject: message.slice(0, 120),
          status: 'in_progress',
          assigned_resource_id: resource.id,
          assigned_user_id: user.id,
          metadata: { started_by: user.id },
        },
      });
    }

    // Persist the user's turn.
    await this.prisma.messages.create({
      data: {
        workspace_id: wsId,
        activity_id: activity.id,
        direction: 'inbound',
        channel: 'chat',
        author_type: 'user',
        author_user_id: user.id,
        body: message,
      },
    });

    // Prior turns on this thread → agent context (continuity across messages).
    const priorMessages = await this.prisma.messages.findMany({
      where: { activity_id: activity.id },
      orderBy: { created_at: 'asc' },
      take: 40,
    });

    const req: AgentRunRequest = {
      run_id: `chat-${activity.id}-${Date.now()}`,
      workspace_id: wsId ?? undefined,
      ai_resource: {
        key: resource.key,
        name: resource.name,
        system_prompt: resource.system_prompt,
        provider: resource.llm_provider,
        model: resource.llm_model,
        temperature: Number(resource.temperature),
        tools: (resource.allowed_tools as string[]) ?? [],
        confidence_threshold: Number(resource.confidence_threshold),
      },
      activity: {
        id: activity.id,
        channel: 'chat',
        subject: activity.subject,
        body: message,
        priority: 'normal',
        customer: null,
      },
      context: {
        thread: priorMessages.map((m) => ({ role: m.direction === 'inbound' ? 'external' : 'internal', text: m.body ?? '' })),
        rag_hints: [],
        rag_hits: [],
      },
      options: { max_tool_intents: 5 },
    };

    let resp: any;
    try {
      resp = await runChatAgent(req);
    } catch (e) {
      throw new BadRequestException(`Agent call failed: ${(e as Error).message}`);
    }

    const replyText = String(resp?.draft?.content ?? '').trim() || '(yanıt üretilemedi)';
    const confidence = resp.confidence ?? 0.5;
    const threshold = Number(resource.confidence_threshold);
    const approvalLimit = resource.approval_limit !== null ? Number(resource.approval_limit) : null;

    // Persist the assistant's turn.
    await this.prisma.messages.create({
      data: {
        workspace_id: wsId,
        activity_id: activity.id,
        direction: 'outbound',
        channel: 'chat',
        author_type: 'ai_resource',
        author_resource_id: resource.id,
        body: replyText,
      },
    });

    // ── Tool-intent gate (mirrors process-activity.ts §4) ──────────────────
    // A synthetic agent_run backs the tool_calls FK (no worker involved for
    // chat, but the approvals pipeline expects one, same as code-tasks.controller.ts).
    let toolIntentsPending = false;
    if ((resp.tool_intents ?? []).length) {
      const run = await this.prisma.agent_runs.create({
        data: {
          workspace_id: wsId,
          activity_id: activity.id,
          ai_resource_id: resource.id,
          llm_provider: resource.llm_provider,
          llm_model: resource.llm_model,
          status: 'succeeded',
          output: resp as any,
          reasoning_summary: resp.reasoning_summary,
          confidence_score: confidence,
          started_at: new Date(),
          finished_at: new Date(),
        },
      });

      let seq = 0;
      for (const intent of resp.tool_intents) {
        const def = isKnownTool(intent.tool) ? TOOL_REGISTRY[intent.tool] : undefined;
        const sensitive = def?.sensitive ?? intent.sensitive ?? false;
        const risk = (def?.risk ?? 'medium') as any;
        const monetary = def?.monetary ?? false;
        const amount = monetary && typeof intent.args?.amount === 'number' ? (intent.args.amount as number) : null;
        const overLimit = amount !== null && approvalLimit !== null && amount > approvalLimit;
        const requiresApproval = sensitive || resp.needs_escalation || confidence < threshold || overLimit;

        const toolCall = await this.prisma.tool_calls.create({
          data: {
            workspace_id: wsId,
            agent_run_id: run.id,
            name: intent.tool,
            args: (intent.args ?? {}) as any,
            requires_approval: requiresApproval,
            risk_level: risk,
            status: requiresApproval ? 'awaiting_approval' : 'approved',
            sequence: seq++,
          },
        });

        if (requiresApproval) {
          toolIntentsPending = true;
          await this.prisma.approvals.create({
            data: {
              workspace_id: wsId,
              activity_id: activity.id,
              agent_run_id: run.id,
              tool_call_id: toolCall.id,
              action: intent.tool,
              payload: (intent.args ?? {}) as any,
              risk_level: risk,
              amount: amount ?? undefined,
              reason: resp.needs_escalation ? 'escalation' : confidence < threshold ? 'low_confidence' : 'sensitive_action',
              status: 'pending',
              requested_by_id: user.id,
            },
          });
          await (this.prisma as any).notifications.create({
            data: {
              workspace_id: wsId,
              type: 'approval_created',
              title: `Approval required: ${intent.tool}`,
              message: `${resource.name} proposed ${intent.tool} from a chat with ${user.display_name}.`,
              metadata: { activityId: activity.id, agentRunId: run.id, toolCallId: toolCall.id },
            },
          });
        }
        // Low-risk/auto-approved intents are left `approved` + unexecuted here —
        // same as any other tool_call awaiting the executor tick; chat does not
        // invoke ExecutorService directly to keep this endpoint fast/synchronous.
      }

      await this.prisma.activities.update({
        where: { id: activity.id },
        data: { status: toolIntentsPending ? 'awaiting_approval' : 'in_progress', requires_approval: toolIntentsPending },
      });
    }

    await this.audit.log({
      actorType: 'user',
      actorUserId: user.id,
      action: 'draft',
      entityType: 'activities',
      entityId: activity.id,
      activityId: activity.id,
      summary: `Chat turn with ${resource.name}${toolIntentsPending ? ' (tool approval pending)' : ''}`,
    });

    emitStreamEvent({ type: 'activity', workspaceId: wsId, payload: activity });

    return { thread_id: activity.id, reply: replyText, tool_intents_pending: toolIntentsPending };
  }
}

@Module({ controllers: [ChatController] })
export class ChatModule {}
```

- [ ] **Step 2: Register the module**

In `services/api/src/app.module.ts`, add the import next to `DevicesModule` and add `ChatModule` to the `imports` array:

```ts
import { ChatModule } from './modules/chat/chat.controller';
// … in @Module imports array, after DevicesModule (or PushDispatcherModule):
    ChatModule,
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @dynops/api typecheck`
Expected: exit 0.

- [ ] **Step 4: Live verify — new thread, reply, tool-intent-free case**

```bash
docker compose build api && docker compose up -d api
until docker compose logs api 2>&1 | tail -20 | grep -q "API listening on :4000"; do sleep 3; done
TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login -H 'content-type: application/json' -d '{"email":"admin@dynamicsops.com"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
WS=$(curl -s http://localhost:4000/api/v1/workspaces -H "authorization: Bearer $TOKEN" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
RESOURCE_KEY=$(docker compose exec -T postgres psql -U dynops -d dynops -tAc "SELECT key FROM ai_resources WHERE status='active' LIMIT 1;")
curl -s -X POST http://localhost:4000/api/v1/chat \
  -H "authorization: Bearer $TOKEN" -H "x-workspace: $WS" -H 'content-type: application/json' \
  -d "{\"resource_key\":\"$RESOURCE_KEY\",\"message\":\"Merhaba, kısaca kendini tanıt.\"}"
```
Expected: `{"thread_id":"…","reply":"…","tool_intents_pending":false}`.

- [ ] **Step 5: Live verify — thread continuation**

```bash
THREAD_ID=<thread_id from Step 4>
curl -s -X POST http://localhost:4000/api/v1/chat \
  -H "authorization: Bearer $TOKEN" -H "x-workspace: $WS" -H 'content-type: application/json' \
  -d "{\"resource_key\":\"$RESOURCE_KEY\",\"thread_id\":\"$THREAD_ID\",\"message\":\"Teşekkürler, bir şey daha soracağım.\"}"
docker compose exec -T postgres psql -U dynops -d dynops -c "SELECT direction, author_type, left(body,60) FROM messages WHERE activity_id='$THREAD_ID' ORDER BY created_at;"
```
Expected: same `thread_id` echoed back; psql shows 4 rows alternating inbound/outbound.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/modules/chat services/api/src/app.module.ts
git commit -m "feat(api): POST /chat — synchronous agent reply + thread persistence (M2 mobile chat)"
```

---

## Task 3: Backend — tool-intent-to-approval live verify (draft-first proof)

**Files:** none new — this task is a verification-only pass over Task 2's code using a resource/prompt that reliably proposes a sensitive tool, to prove chat cannot bypass the Approval Center. If your seeded resources don't reliably propose a tool call from a short prompt, this task also adds one tiny, safe seed adjustment.

**Interfaces:**
- Consumes: Task 2's `POST /chat`.
- Produces: no new code — a verified proof that `tool_intents` become `pending` `approvals` rows.

- [ ] **Step 1: Find (or seed) a resource with `send_email` in `allowed_tools`**

```bash
docker compose exec -T postgres psql -U dynops -d dynops -c "SELECT key, allowed_tools FROM ai_resources WHERE allowed_tools::text LIKE '%send_email%' AND status='active' LIMIT 3;"
```
If none exist, skip to Step 4 with a manual DB-level proof instead of relying on the LLM to propose a tool call (LLM tool-call reliability varies by local model — the gate logic itself is what we're proving, not the model's tool-calling accuracy).

- [ ] **Step 2: Ask that resource to do something requiring `send_email`**

```bash
curl -s -X POST http://localhost:4000/api/v1/chat \
  -H "authorization: Bearer $TOKEN" -H "x-workspace: $WS" -H 'content-type: application/json' \
  -d '{"resource_key":"<key-from-step-1>","message":"contoso müşterisine durumu özetleyen kısa bir e-posta gönder."}'
```

- [ ] **Step 3: If `tool_intents_pending:true`, verify the approval landed in the normal queue**

```bash
curl -s "http://localhost:4000/api/v1/approvals?status=pending" -H "authorization: Bearer $TOKEN" -H "x-workspace: $WS" | grep -o '"action":"send_email"'
```
Expected: at least one `"action":"send_email"` — i.e. it shows up in the exact same `GET /approvals?status=pending` the web Approval Center and the mobile Approvals tab (M1) already use. No separate "chat approvals" list exists — this is the point.

- [ ] **Step 4 (fallback, if the model didn't propose a tool call): direct gate-logic proof**

```bash
docker compose exec -T postgres psql -U dynops -d dynops -c "
INSERT INTO tool_calls (id, workspace_id, agent_run_id, name, args, requires_approval, risk_level, status, sequence)
SELECT gen_random_uuid(), a.workspace_id, r.id, 'send_email', '{\"to\":[\"test@contoso.com\"],\"content\":\"test\"}', true, 'medium', 'awaiting_approval', 0
FROM agent_runs r JOIN activities a ON a.id = r.activity_id WHERE r.activity_id = '$THREAD_ID' LIMIT 1;
"
```
This is a smoke check only for the DB shape, not a substitute for Steps 2–3 when a suitable resource exists.

- [ ] **Step 5: Commit**

Nothing to commit if no seed change was needed. If a resource's `allowed_tools` was adjusted for testability, commit that seed change separately with a clear message — otherwise skip this step.

---

## Task 4: Mobile — chat models + repository (resource picker, threads, messages)

**Files:**
- Create: `apps/mobile/lib/features/chat/chat_models.dart`
- Create: `apps/mobile/lib/features/chat/chat_repository.dart`
- Test: `apps/mobile/test/chat_models_test.dart`

**Interfaces:**
- Consumes: `ApiClient`/`sessionProvider` (`apps/mobile/lib/core/session.dart`), `unwrapList` (`apps/mobile/lib/features/approvals/approvals_models.dart`); API `GET /ai-resources?active=true`, `GET /chat/threads`, `GET /chat/threads/:id/messages`, `POST /chat`.
- Produces: `ChatResource.fromJson`, `ChatThread.fromJson`, `ChatMessage.fromJson`, `chatResourcesProvider`, `chatThreadsProvider`, `chatMessagesProvider` (family by thread id), `ChatActions.send(resourceKey, message, {threadId})`. Task 5 (screens) is the sole consumer.

- [ ] **Step 1: Write the failing model test**

Create `apps/mobile/test/chat_models_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/features/chat/chat_models.dart';

void main() {
  test('parses ai-resources list for the picker', () {
    final r = ChatResource.fromJson({'id': 'r1', 'key': 'ai_executive_assistant', 'name': 'Executive Assistant', 'role': 'EA', 'status': 'active'});
    expect(r.key, 'ai_executive_assistant');
    expect(r.name, 'Executive Assistant');
  });

  test('parses a chat thread summary', () {
    final t = ChatThread.fromJson({
      'id': 'th1',
      'subject': 'Merhaba, kısaca kendini tanıt.',
      'status': 'in_progress',
      'resource': {'id': 'r1', 'key': 'ai_executive_assistant', 'name': 'Executive Assistant'},
      'last_message': 'Merhaba! Ben...',
      'last_message_at': '2026-07-04T10:00:00Z',
    });
    expect(t.subject, 'Merhaba, kısaca kendini tanıt.');
    expect(t.resourceName, 'Executive Assistant');
    expect(t.lastMessage, 'Merhaba! Ben...');
  });

  test('parses chat messages with direction', () {
    final m = ChatMessage.fromJson({'id': 'm1', 'direction': 'inbound', 'author_type': 'user', 'body': 'Selam', 'created_at': '2026-07-04T10:00:00Z'});
    expect(m.isUser, true);
    expect(m.body, 'Selam');

    final reply = ChatMessage.fromJson({'id': 'm2', 'direction': 'outbound', 'author_type': 'ai_resource', 'body': 'Merhaba!', 'created_at': '2026-07-04T10:00:05Z'});
    expect(reply.isUser, false);
  });

  test('send() response parses thread_id + reply', () {
    final r = ChatSendResult.fromJson({'thread_id': 'th1', 'reply': 'Merhaba!', 'tool_intents_pending': false});
    expect(r.threadId, 'th1');
    expect(r.reply, 'Merhaba!');
    expect(r.toolIntentsPending, false);
  });
}
```

Run: `cd apps/mobile && flutter test test/chat_models_test.dart` — expected FAIL (file missing).

- [ ] **Step 2: Implement the models**

Create `apps/mobile/lib/features/chat/chat_models.dart`:

```dart
class ChatResource {
  ChatResource({required this.id, required this.key, required this.name, this.role});
  final String id;
  final String key;
  final String name;
  final String? role;

  factory ChatResource.fromJson(Map<String, dynamic> j) => ChatResource(
        id: j['id'] as String,
        key: j['key'] as String,
        name: (j['name'] ?? j['key']) as String,
        role: j['role'] as String?,
      );
}

class ChatThread {
  ChatThread({
    required this.id,
    this.subject,
    this.status,
    this.resourceId,
    this.resourceName,
    this.lastMessage,
    this.lastMessageAt,
  });

  final String id;
  final String? subject;
  final String? status;
  final String? resourceId;
  final String? resourceName;
  final String? lastMessage;
  final DateTime? lastMessageAt;

  factory ChatThread.fromJson(Map<String, dynamic> j) {
    final resource = (j['resource'] as Map?)?.cast<String, dynamic>();
    return ChatThread(
      id: j['id'] as String,
      subject: j['subject'] as String?,
      status: j['status'] as String?,
      resourceId: resource?['id'] as String?,
      resourceName: resource?['name'] as String?,
      lastMessage: j['last_message'] as String?,
      lastMessageAt: j['last_message_at'] != null ? DateTime.tryParse(j['last_message_at'] as String) : null,
    );
  }
}

class ChatMessage {
  ChatMessage({required this.id, required this.direction, required this.authorType, this.body, this.isDraft = false, this.createdAt});

  final String id;
  final String direction; // 'inbound' | 'outbound' | 'internal'
  final String authorType; // 'user' | 'ai_resource'
  final String? body;
  final bool isDraft;
  final DateTime? createdAt;

  bool get isUser => direction == 'inbound';

  factory ChatMessage.fromJson(Map<String, dynamic> j) => ChatMessage(
        id: j['id'] as String,
        direction: (j['direction'] ?? 'inbound') as String,
        authorType: (j['author_type'] ?? 'user') as String,
        body: j['body'] as String?,
        isDraft: (j['is_draft'] ?? false) as bool,
        createdAt: j['created_at'] != null ? DateTime.tryParse(j['created_at'] as String) : null,
      );
}

class ChatSendResult {
  ChatSendResult({required this.threadId, required this.reply, required this.toolIntentsPending});
  final String threadId;
  final String reply;
  final bool toolIntentsPending;

  factory ChatSendResult.fromJson(Map<String, dynamic> j) => ChatSendResult(
        threadId: j['thread_id'] as String,
        reply: (j['reply'] ?? '') as String,
        toolIntentsPending: (j['tool_intents_pending'] ?? false) as bool,
      );
}
```

- [ ] **Step 3: Implement the repository**

Create `apps/mobile/lib/features/chat/chat_repository.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/session.dart';
import '../approvals/approvals_models.dart';
import 'chat_models.dart';

final chatResourcesProvider = FutureProvider.autoDispose<List<ChatResource>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/ai-resources', query: {'active': 'true'});
  return unwrapList(body).map(ChatResource.fromJson).toList();
});

final chatThreadsProvider = FutureProvider.autoDispose<List<ChatThread>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/chat/threads');
  return unwrapList(body).map(ChatThread.fromJson).toList();
});

final chatMessagesProvider = FutureProvider.autoDispose.family<List<ChatMessage>, String>((ref, threadId) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/chat/threads/$threadId/messages') as Map;
  final list = (body['messages'] as List? ?? const []);
  return list.map((e) => ChatMessage.fromJson((e as Map).cast<String, dynamic>())).toList();
});

class ChatActions {
  ChatActions(this.ref);
  final Ref ref;

  Future<ChatSendResult> send({required String resourceKey, required String message, String? threadId}) async {
    final api = ref.read(sessionProvider)!.api;
    final body = await api.post('/chat', body: {
      'resource_key': resourceKey,
      'message': message,
      if (threadId != null) 'thread_id': threadId,
    }) as Map;
    return ChatSendResult.fromJson(body.cast<String, dynamic>());
  }
}

final chatActionsProvider = Provider((ref) => ChatActions(ref));
```

- [ ] **Step 4: Run analyze + tests**

Run: `cd apps/mobile && flutter analyze && flutter test test/chat_models_test.dart`
Expected: clean, 4 new tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/features/chat/chat_models.dart apps/mobile/lib/features/chat/chat_repository.dart apps/mobile/test/chat_models_test.dart
git commit -m "feat(mobile): chat models + repository (resources, threads, messages, send)"
```

---

## Task 5: Mobile — chat screens (resource picker, threads list, conversation view, compose)

**Files:**
- Create: `apps/mobile/lib/features/chat/chat_threads_screen.dart`
- Create: `apps/mobile/lib/features/chat/chat_resource_picker_sheet.dart`
- Create: `apps/mobile/lib/features/chat/chat_conversation_screen.dart`
- Modify: `apps/mobile/lib/core/router.dart` (replace the `/chat` placeholder with real routes)
- Test: `apps/mobile/test/chat_screen_test.dart`

**Interfaces:**
- Consumes: Task 4's providers/models; `sessionProvider` (role gating not needed here — chat is available to all roles, same as the web).
- Produces: routes `/chat` (threads list + "new chat" FAB), `/chat/:id` (conversation). Task 6 adds voice input into the compose box built here; Task 7 adds the approval cross-link banner.

- [ ] **Step 1: Write the failing widget test**

Create `apps/mobile/test/chat_screen_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/features/chat/chat_conversation_screen.dart';

void main() {
  testWidgets('conversation screen renders a compose box and send button', (tester) async {
    await tester.pumpWidget(const ProviderScope(
      child: MaterialApp(home: ChatConversationScreen(threadId: null, resourceKey: 'ai_executive_assistant', resourceName: 'Executive Assistant')),
    ));
    await tester.pump();
    expect(find.byType(TextField), findsOneWidget);
    expect(find.byIcon(Icons.send), findsOneWidget);
  });
}
```

Run: `cd apps/mobile && flutter test test/chat_screen_test.dart` — expected FAIL (file missing).

- [ ] **Step 2: Implement the resource picker bottom sheet**

Create `apps/mobile/lib/features/chat/chat_resource_picker_sheet.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'chat_models.dart';
import 'chat_repository.dart';

/// Bottom sheet: pick which active AI resource to start a new chat with.
/// Returns the chosen [ChatResource] via Navigator.pop, or null if dismissed.
Future<ChatResource?> showResourcePicker(BuildContext context, WidgetRef ref) {
  return showModalBottomSheet<ChatResource>(
    context: context,
    isScrollControlled: true,
    builder: (ctx) => Consumer(
      builder: (ctx, ref, _) {
        final resources = ref.watch(chatResourcesProvider);
        return SafeArea(
          child: SizedBox(
            height: MediaQuery.of(ctx).size.height * 0.6,
            child: resources.when(
              loading: () => const Center(child: CircularProgressIndicator()),
              error: (e, _) => Center(child: Text('Hata: $e')),
              data: (items) => ListView.builder(
                padding: const EdgeInsets.symmetric(vertical: 12),
                itemCount: items.length,
                itemBuilder: (_, i) {
                  final r = items[i];
                  return ListTile(
                    leading: const CircleIcon(),
                    title: Text(r.name),
                    subtitle: r.role != null ? Text(r.role!) : null,
                    onTap: () => Navigator.pop(ctx, r),
                  );
                },
              ),
            ),
          ),
        );
      },
    ),
  );
}

class CircleIcon extends StatelessWidget {
  const CircleIcon({super.key});
  @override
  Widget build(BuildContext context) => const CircleAvatar(child: Icon(Icons.smart_toy_outlined));
}
```

- [ ] **Step 3: Implement the threads list screen**

Create `apps/mobile/lib/features/chat/chat_threads_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';
import 'chat_repository.dart';
import 'chat_resource_picker_sheet.dart';

class ChatThreadsScreen extends ConsumerWidget {
  const ChatThreadsScreen({super.key});

  Future<void> _newChat(BuildContext context, WidgetRef ref) async {
    final resource = await showResourcePicker(context, ref);
    if (resource == null || !context.mounted) return;
    context.push('/chat/new?resourceKey=${Uri.encodeComponent(resource.key)}&resourceName=${Uri.encodeComponent(resource.name)}');
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final threads = ref.watch(chatThreadsProvider);
    final fmt = DateFormat('d MMM HH:mm');
    return Scaffold(
      appBar: AppBar(title: const Text('Sohbet')),
      floatingActionButton: FloatingActionButton(
        onPressed: () => _newChat(context, ref),
        child: const Icon(Icons.add_comment_outlined),
      ),
      body: threads.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (items) => items.isEmpty
            ? const Center(child: Text('Henüz sohbet yok. Başlamak için + düğmesine dokun.'))
            : RefreshIndicator(
                onRefresh: () async => ref.invalidate(chatThreadsProvider),
                child: ListView.builder(
                  itemCount: items.length,
                  itemBuilder: (_, i) {
                    final t = items[i];
                    return ListTile(
                      leading: const CircleAvatar(child: Icon(Icons.smart_toy_outlined)),
                      title: Text(t.resourceName ?? t.subject ?? 'Sohbet', maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text(t.lastMessage ?? t.subject ?? '', maxLines: 1, overflow: TextOverflow.ellipsis),
                      trailing: t.lastMessageAt != null ? Text(fmt.format(t.lastMessageAt!.toLocal()), style: Theme.of(context).textTheme.bodySmall) : null,
                      onTap: () => context.push(
                        '/chat/${t.id}?resourceKey=${Uri.encodeComponent('')}&resourceName=${Uri.encodeComponent(t.resourceName ?? '')}',
                      ),
                    );
                  },
                ),
              ),
      ),
    );
  }
}
```

- [ ] **Step 4: Implement the conversation screen (bubbles + compose)**

Create `apps/mobile/lib/features/chat/chat_conversation_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'chat_models.dart';
import 'chat_repository.dart';

/// A conversation with one AI resource. `threadId == null` means "new chat" —
/// the first send() call creates the thread and this screen adopts its id.
class ChatConversationScreen extends ConsumerStatefulWidget {
  const ChatConversationScreen({super.key, required this.threadId, required this.resourceKey, required this.resourceName});
  final String? threadId;
  final String resourceKey;
  final String resourceName;

  @override
  ConsumerState<ChatConversationScreen> createState() => _ChatConversationScreenState();
}

class _ChatConversationScreenState extends ConsumerState<ChatConversationScreen> {
  final _composeCtl = TextEditingController();
  final _scrollCtl = ScrollController();
  String? _threadId;
  final List<ChatMessage> _optimistic = [];
  bool _sending = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _threadId = widget.threadId;
  }

  Future<void> _send() async {
    final text = _composeCtl.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _error = null;
      _optimistic.add(ChatMessage(id: 'local-${DateTime.now().microsecondsSinceEpoch}', direction: 'inbound', authorType: 'user', body: text, createdAt: DateTime.now()));
    });
    _composeCtl.clear();
    try {
      final result = await ref.read(chatActionsProvider).send(resourceKey: widget.resourceKey, message: text, threadId: _threadId);
      setState(() => _threadId = result.threadId);
      ref.invalidate(chatMessagesProvider(result.threadId));
      ref.invalidate(chatThreadsProvider);
      if (result.toolIntentsPending && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Bu istek bir onay gerektiriyor — Onaylar sekmesinde bekliyor.')),
        );
      }
    } catch (e) {
      setState(() => _error = 'Gönderilemedi: $e');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final messagesAsync = _threadId != null ? ref.watch(chatMessagesProvider(_threadId!)) : null;
    return Scaffold(
      appBar: AppBar(title: Text(widget.resourceName)),
      body: Column(children: [
        Expanded(
          child: messagesAsync == null
              ? _bubbleList(_optimistic)
              : messagesAsync.when(
                  loading: () => _bubbleList(_optimistic),
                  error: (e, _) => Center(child: Text('Hata: $e')),
                  data: (persisted) {
                    // Drop optimistic entries once the real thread has messages.
                    final merged = persisted.isNotEmpty ? persisted : _optimistic;
                    return _bubbleList(merged);
                  },
                ),
        ),
        if (_error != null) Padding(padding: const EdgeInsets.all(8), child: Text(_error!, style: const TextStyle(color: Colors.redAccent))),
        SafeArea(
          child: Padding(
            padding: const EdgeInsets.all(8),
            child: Row(children: [
              Expanded(
                child: TextField(
                  controller: _composeCtl,
                  minLines: 1,
                  maxLines: 4,
                  decoration: const InputDecoration(hintText: 'Mesaj yaz…', border: OutlineInputBorder()),
                  onSubmitted: (_) => _send(),
                ),
              ),
              const SizedBox(width: 8),
              _sending
                  ? const SizedBox(height: 24, width: 24, child: CircularProgressIndicator(strokeWidth: 2))
                  : IconButton(icon: const Icon(Icons.send), onPressed: _send),
            ]),
          ),
        ),
      ]),
    );
  }

  Widget _bubbleList(List<ChatMessage> items) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollCtl.hasClients) _scrollCtl.jumpTo(_scrollCtl.position.maxScrollExtent);
    });
    if (items.isEmpty) return const Center(child: Text('Bir mesaj yazarak başla.'));
    return ListView.builder(
      controller: _scrollCtl,
      padding: const EdgeInsets.all(12),
      itemCount: items.length,
      itemBuilder: (_, i) {
        final m = items[i];
        return Align(
          alignment: m.isUser ? Alignment.centerRight : Alignment.centerLeft,
          child: Container(
            margin: const EdgeInsets.symmetric(vertical: 4),
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
            constraints: BoxConstraints(maxWidth: MediaQuery.of(context).size.width * 0.75),
            decoration: BoxDecoration(
              color: m.isUser ? Theme.of(context).colorScheme.primaryContainer : Theme.of(context).colorScheme.surfaceContainerHighest,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Text(m.body ?? ''),
          ),
        );
      },
    );
  }
}
```

- [ ] **Step 5: Wire routes**

In `apps/mobile/lib/core/router.dart`, replace the `/chat` placeholder line and add the two real routes + imports:

```dart
import '../features/chat/chat_threads_screen.dart';
import '../features/chat/chat_conversation_screen.dart';
// … replace:
//   GoRoute(path: '/chat', builder: (_, __) => const Scaffold(body: Center(child: Text('Sohbet — M2\'de geliyor')))),
// with:
            GoRoute(path: '/chat', builder: (_, __) => const ChatThreadsScreen()),
            GoRoute(
              path: '/chat/:id',
              builder: (_, s) => ChatConversationScreen(
                threadId: s.pathParameters['id'] == 'new' ? null : s.pathParameters['id'],
                resourceKey: s.uri.queryParameters['resourceKey'] ?? '',
                resourceName: s.uri.queryParameters['resourceName'] ?? 'Sohbet',
              ),
            ),
```

- [ ] **Step 6: Analyze + tests**

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: clean, all tests pass (chat widget test + Task 4's model tests).

- [ ] **Step 7: Manual smoke (stack running)**

`flutter run` → tap Sohbet tab → + → pick a resource → type a message → send → reply bubble appears → back → thread shows in the list with last-message preview.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/lib/features/chat apps/mobile/lib/core/router.dart apps/mobile/test/chat_screen_test.dart
git commit -m "feat(mobile): chat screens — resource picker, threads list, conversation view"
```

---

## Task 6: Mobile — voice input (speech_to_text) + optional TTS toggle

**Files:**
- Modify: `apps/mobile/pubspec.yaml` (add `speech_to_text`, `flutter_tts`)
- Modify: `apps/mobile/lib/features/chat/chat_conversation_screen.dart` (mic button + TTS toggle)
- Modify: `apps/mobile/ios/Runner/Info.plist` (mic + speech-recognition usage strings)
- Modify: `apps/mobile/android/app/src/main/AndroidManifest.xml` (RECORD_AUDIO permission)
- Test: extend `apps/mobile/test/chat_screen_test.dart`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: a mic `IconButton` next to compose that dictates into `_composeCtl` (tr-TR/en-US), and a TTS speaker-icon toggle in the AppBar that reads the latest assistant reply aloud when enabled. Both are best-effort/no-op if the plugin can't initialize (mirrors `apps/mobile/lib/core/push.dart`'s guarded-init pattern from M1).

- [ ] **Step 1: Add dependencies**

In `apps/mobile/pubspec.yaml` add to `dependencies:`:

```yaml
  speech_to_text: ^7.0.0
  flutter_tts: ^4.0.2
```

Run: `export PATH="$HOME/development/flutter/bin:$PATH"; cd apps/mobile && flutter pub get`
Expected: resolves cleanly.

- [ ] **Step 2: iOS permission strings**

In `apps/mobile/ios/Runner/Info.plist`, add inside the top-level `<dict>`:

```xml
	<key>NSMicrophoneUsageDescription</key>
	<string>DynOps sohbet ekranında sesli mesaj yazmak için mikrofona ihtiyaç duyar.</string>
	<key>NSSpeechRecognitionUsageDescription</key>
	<string>Söylediklerinizi metne çevirmek için konuşma tanıma kullanılır.</string>
```

- [ ] **Step 3: Android permission**

In `apps/mobile/android/app/src/main/AndroidManifest.xml`, add before `<application`:

```xml
    <uses-permission android:name="android.permission.RECORD_AUDIO" />
```

- [ ] **Step 4: Implement guarded voice input + TTS in the conversation screen**

Modify `apps/mobile/lib/features/chat/chat_conversation_screen.dart`: add imports, state fields, init/dispose, mic button, and TTS toggle.

Add imports at the top:

```dart
import 'package:speech_to_text/speech_to_text.dart' as stt;
import 'package:flutter_tts/flutter_tts.dart';
import 'dart:ui' show Locale;
```

Add fields + lifecycle to `_ChatConversationScreenState`:

```dart
  final stt.SpeechToText _speech = stt.SpeechToText();
  final FlutterTts _tts = FlutterTts();
  bool _speechAvailable = false;
  bool _listening = false;
  bool _ttsEnabled = false;

  @override
  void initState() {
    super.initState();
    _threadId = widget.threadId;
    _initSpeech();
  }

  Future<void> _initSpeech() async {
    try {
      _speechAvailable = await _speech.initialize(onStatus: (s) {
        if (s == 'done' || s == 'notListening') setState(() => _listening = false);
      });
    } catch (_) {
      _speechAvailable = false; // best-effort: mic button hides if unavailable
    }
    if (mounted) setState(() {});
  }

  Future<void> _toggleListening() async {
    if (!_speechAvailable) return;
    if (_listening) {
      await _speech.stop();
      setState(() => _listening = false);
      return;
    }
    setState(() => _listening = true);
    final localeId = Localizations.localeOf(context).languageCode == 'tr' ? 'tr_TR' : 'en_US';
    await _speech.listen(
      localeId: localeId,
      onResult: (result) {
        setState(() {
          _composeCtl.text = result.recognizedWords;
          _composeCtl.selection = TextSelection.collapsed(offset: _composeCtl.text.length);
        });
      },
    );
  }

  Future<void> _maybeSpeak(String text) async {
    if (!_ttsEnabled || text.isEmpty) return;
    try {
      await _tts.setLanguage(Localizations.localeOf(context).languageCode == 'tr' ? 'tr-TR' : 'en-US');
      await _tts.speak(text);
    } catch (_) {
      /* TTS is best-effort; never break the chat flow */
    }
  }

  @override
  void dispose() {
    _speech.stop();
    _tts.stop();
    super.dispose();
  }
```

In `_send()`, after the `ChatSendResult` succeeds (right after `ref.invalidate(chatThreadsProvider);`), speak the reply:

```dart
      await _maybeSpeak(result.reply);
```

In `build()`, add a TTS toggle action to the `AppBar`:

```dart
      appBar: AppBar(title: Text(widget.resourceName), actions: [
        IconButton(
          icon: Icon(_ttsEnabled ? Icons.volume_up : Icons.volume_off),
          tooltip: 'Sesli yanıt',
          onPressed: () => setState(() => _ttsEnabled = !_ttsEnabled),
        ),
      ]),
```

In the compose `Row`, add the mic button before the send button (only when available):

```dart
              if (_speechAvailable)
                IconButton(
                  icon: Icon(_listening ? Icons.mic : Icons.mic_none, color: _listening ? Colors.redAccent : null),
                  onPressed: _toggleListening,
                ),
```

- [ ] **Step 5: Extend the widget test**

Append to `apps/mobile/test/chat_screen_test.dart`:

```dart
  testWidgets('conversation screen renders a TTS toggle in the AppBar', (tester) async {
    await tester.pumpWidget(const ProviderScope(
      child: MaterialApp(home: ChatConversationScreen(threadId: null, resourceKey: 'ai_executive_assistant', resourceName: 'Executive Assistant')),
    ));
    await tester.pump();
    expect(find.byIcon(Icons.volume_off), findsOneWidget);
  });
```

- [ ] **Step 6: Analyze + tests**

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: clean. On CI/headless test runners `speech_to_text`'s `initialize()` will fail (no platform channel) — this is handled by the try/catch in `_initSpeech`, so `_speechAvailable` stays `false` and the mic button simply doesn't render; the widget test only asserts the TTS icon (always rendered) and the pre-existing send/TextField assertions from Task 5, so no test flakes on speech init.

- [ ] **Step 7: Manual smoke on a real device/simulator**

`flutter run` → open a chat → tap mic → speak → recognized text appears in the compose box → send → toggle the speaker icon on → send another message → hear the reply read aloud.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/pubspec.yaml apps/mobile/pubspec.lock apps/mobile/ios/Runner/Info.plist apps/mobile/android/app/src/main/AndroidManifest.xml apps/mobile/lib/features/chat/chat_conversation_screen.dart apps/mobile/test/chat_screen_test.dart
git commit -m "feat(mobile): voice input (speech_to_text) + optional TTS toggle in chat"
```

---

## Task 7: Mobile — tool-intent → Approvals cross-link

**Files:**
- Modify: `apps/mobile/lib/features/chat/chat_conversation_screen.dart` (persistent banner instead of only a SnackBar)
- Modify: `apps/mobile/lib/features/chat/chat_threads_screen.dart` (pending-approval badge on the thread row, optional but included since it's cheap)

**Interfaces:**
- Consumes: `ChatSendResult.toolIntentsPending` (Task 4); go_router navigation to `/approvals` (existing M1 tab, `apps/mobile/lib/features/approvals/approvals_screen.dart`).
- Produces: a tappable banner in the conversation screen that deep-links to the Approvals tab whenever the latest turn produced a pending approval.

- [ ] **Step 1: Add a persistent banner to the conversation screen**

In `apps/mobile/lib/features/chat/chat_conversation_screen.dart`, add a field and update `_send()`:

```dart
  bool _lastTurnHasPendingApproval = false;
```

Replace the `if (result.toolIntentsPending && mounted) { ScaffoldMessenger... }` block from Task 5 with:

```dart
      setState(() => _lastTurnHasPendingApproval = result.toolIntentsPending);
```

Add the banner in `build()`, right above the `Expanded` message list:

```dart
        if (_lastTurnHasPendingApproval)
          Material(
            color: Theme.of(context).colorScheme.tertiaryContainer,
            child: InkWell(
              onTap: () => context.push('/approvals'),
              child: const Padding(
                padding: EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                child: Row(children: [
                  Icon(Icons.fact_check_outlined, size: 18),
                  SizedBox(width: 8),
                  Expanded(child: Text('Bu istek bir onay gerektiriyor. Onaylar sekmesinde incele →')),
                ]),
              ),
            ),
          ),
```

Add the import: `import 'package:go_router/go_router.dart';`

- [ ] **Step 2: Add a pending-approval indicator to the threads list (optional polish)**

In `apps/mobile/lib/features/chat/chat_threads_screen.dart`, show a small icon when `t.status == 'awaiting_approval'`:

```dart
                      trailing: Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.end, children: [
                        if (t.lastMessageAt != null) Text(fmt.format(t.lastMessageAt!.toLocal()), style: Theme.of(context).textTheme.bodySmall),
                        if (t.status == 'awaiting_approval')
                          const Padding(padding: EdgeInsets.only(top: 4), child: Icon(Icons.pending_actions, size: 16, color: Colors.amber)),
                      ]),
```
(Replace the existing single-`Text` `trailing:` with this `Column`.)

- [ ] **Step 3: Analyze + tests**

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: clean, all existing tests still pass (no new test required — this is a thin UI addition over already-tested data; Task 5/6 tests already cover the screen's core render path).

- [ ] **Step 4: Manual smoke**

Using the resource identified in Task 3 (one with `send_email` in `allowed_tools`), send a chat message that asks it to send an email → banner appears → tap it → lands on `/approvals` → the same approval is visible there (M1's approve/reject flow works on it unchanged).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/features/chat/chat_conversation_screen.dart apps/mobile/lib/features/chat/chat_threads_screen.dart
git commit -m "feat(mobile): cross-link chat tool-intent approvals to the Approvals tab"
```

---

## Final verification (whole M2)

- [ ] `pnpm --filter @dynops/shared build && pnpm --filter @dynops/db build && pnpm --filter @dynops/api typecheck` → all exit 0.
- [ ] `docker compose build api && docker compose up -d` → api boots cleanly, no errors in `docker compose logs api`.
- [ ] Backend curl loop (Task 2 Steps 4–5 + Task 3): new thread → reply → continuation → (if a tool-capable resource exists) tool intent → pending approval visible via `GET /approvals?status=pending`.
- [ ] `cd apps/mobile && export PATH="$HOME/development/flutter/bin:$PATH" && flutter analyze && flutter test` → clean, all tests pass (Task 4's 4 model tests + Task 5/6's widget tests + all M1 tests still green).
- [ ] Manual device pass: Sohbet tab → + → pick a resource → type + send → reply renders → back → thread appears in list with preview → reopen thread → history persists (`GET /chat/threads/:id/messages` round-trip) → mic button dictates text → TTS toggle reads a reply aloud → a tool-triggering message shows the approval banner → tapping it opens `/approvals` and the same item is decidable there.
- [ ] Confirm `activity_channel` now includes `chat` end-to-end: `docker compose exec postgres psql -U dynops -d dynops -c "SELECT DISTINCT channel FROM activities;"` shows a `chat` row after the manual pass.
- [ ] Push to GitHub when the user asks (repo convention: direct-to-main, dated commits). If a plain `git commit` stalls under the iCloud-synced working tree for `apps/mobile` changes, retry with `--no-verify -c commit.gpgsign=false` per the Global Constraints note — never as a first resort.

## Deferred to its own plan

- **M3 Operator:** `phone_task` tool + `device_commands` lifecycle + Kotlin AccessibilityService engine + permissions onboarding (Android internal flavor) — unaffected by this plan.

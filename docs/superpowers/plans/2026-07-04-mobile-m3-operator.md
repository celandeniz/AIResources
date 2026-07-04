# DynOps Mobile — M3 Operator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship M3 of the DynOps Mobile app — a **server-driven, approval-gated autonomous phone operator**. The server agent proposes a `phone_task` (a step-script: `open_app`/`tap`/`type`/`wait`/`assert`), it lands in the existing Approval Center like any other sensitive tool call, and only on human approval does the phone execute it via a Kotlin `AccessibilityService`. Per the approved spec `docs/superpowers/specs/2026-06-14-mobile-app-design.md` §1/§3.3/§4.

**Architecture (non-negotiable):** the phone has **no agent brain**. It is a dumb, approval-gated executor of a pre-planned step-script. All planning happens server-side (the existing agent-run → tool-call pipeline). The Android `AccessibilityService` only ever runs a script that a human has already approved in the Approval Center — this mirrors the design spec's explicit rejection of OpenOmniBot's on-device agent brain ("we reuse its Flutter chat-UI patterns and its Android accessibility/vision executor architecture — concept + code reference. We do **not** adopt its on-device agent brain: ours stays server-driven and approval-gated").

**Reference pattern (critical — read before starting):** `services/worker/src/mission.ts`'s `writeBackToParent` function is the canonical "propose an approval without executing anything" chain in this codebase: synthetic `agent_runs` (status `succeeded`, fake attribution) → `tool_calls` (status `awaiting_approval`, `requires_approval: true`) → `approvals` (status `pending`). M3's phone-task proposal path mirrors this exact chain, but the sibling outcome table is `device_commands` instead of directly executing an adapter. The `code_task` tool (`targets: 'internal'`, `sensitive: true`, `risk: 'high'`) plus its `executor.service.ts` write-back-onto-a-sibling-row pattern (lines ~126-139, keyed on `args.code_task_id`) is the second reference: `phone_task` will do the same keyed on `args.device_command_id`.

**Tech Stack:** Backend: NestJS + Prisma (existing), BullMQ (existing `QueueService`), FCM HTTP v1 `sendFcm` (existing, extended for a data-only silent push). Mobile: Flutter (Dart 3, Riverpod, go_router, http — all existing, no new Flutter deps except `local_auth` for optional biometric confirm). Android: Kotlin `AccessibilityService` + a `MethodChannel` bridge in `MainActivity.kt` (currently empty — first platform channel in this app).

## Global Constraints

- **Approval-gated, always.** No code path may execute a `device_commands` step-script without that command having passed through `approvals.status = 'approved'` first. There is no "auto-approve" tier for `phone_task` — `sensitive: true` unconditionally routes it to `ALWAYS_APPROVE` in `packages/shared/src/tool-intents.ts`.
- **Server-driven, no on-device planning.** The Kotlin executor interprets a fixed, small op vocabulary (`open_app | tap | type | wait | assert`) it receives verbatim from the server. It never re-plans, never calls an LLM, never decides the next step — it only executes the array it was given and reports back.
- **Tenant scoping.** Every `device_commands` row carries `workspace_id`; every controller endpoint reads/writes scoped to the caller's `x-workspace` (via `tenantStore`, same as `devices.controller.ts`) and the caller's own `user_id` (a user only ever sees/executes their own device commands — mirrors `devices.controller.ts`'s `unregister` being scoped to `user_id: user.id`).
- **Android-only.** The `operator/` Flutter feature and its route are gated behind `Platform.isAndroid` (there is no Flutter-flavor infrastructure in this repo yet — see Task 6 — so this is a **runtime** guard, not a build-time one, consistent with the only existing platform check in `core/push.dart`). iOS builds simply never show the tab/route; no code is compiled out via flavors in this plan (flavors are out of scope — see Risks).
- **Internal distribution only.** No Play Store submission. This sidesteps Play's Accessibility API policy (apps requesting `BIND_ACCESSIBILITY_SERVICE` for non-accessibility purposes face store rejection/removal) — internal APK / ad-hoc distribution only, per spec §1 "Distribution: internal".
- **Guardrails are load-bearing, not cosmetic:**
  - TTL: a `device_commands` row not acted on within `expires_at` (default 15 min from `approved`) must never be executed late — check `expires_at` lazily on every read/write path (no cron needed for M3; see Task 3).
  - Partial-script failure is **never** silently reported as `succeeded`. If any step fails or an `assert` mismatches, the whole command is `failed`, with per-step logs preserved in `result`.
  - Screenshot/vision capture is **off by default** (spec §3.3) — the Kotlin engine in this plan does not capture or upload screen images; `assert` is text/node-tree based only (via `AccessibilityNodeInfo`, not OCR/vision).
  - Biometric confirm before executing a high-risk command is a **device-local, optional, additive** gate (a user setting) — it never replaces server-side approval, only adds a second local checkpoint before the Kotlin engine fires.
- **Existing-pattern reuse, not reinvention:**
  - New Prisma models accessed as `(this.prisma as any).device_commands` (repo's established late-added-model pattern; see M1's `device_tokens` precedent).
  - `device_commands.status` is a bare `String` column with an inline comment enumerating values (matches `code_tasks.status`'s convention — the more recently established idiom in this schema vs. the older `tool_call_status`/`approval_status` Prisma enums), **not** a new Prisma enum — avoids an enum migration for what is an internal-only, evolving status list.
  - `payload`/`result` are `Json` — `payload: Json @default("[]")` (array of step objects, mirrors `tools_used`/`depends_on` array convention), `result: Json?` (nullable — "not yet populated" is meaningfully distinct from "empty", mirrors `tool_calls.result`/`code_tasks.result`).
- **Backend verification:** `pnpm --filter @dynops/api typecheck` must exit 0; schema applied via the api container boot command (`pnpm --filter @dynops/db push`); live checks via curl + `docker compose exec postgres psql`.
- **Flutter verification:** `flutter analyze` (no errors) + `flutter test` (all pass) inside `apps/mobile`.
- **Do not** touch `emitStreamEvent` call sites for this feature — SSE stream events are for the web app's realtime approval feed; the phone-command wake-up path is push (FCM data message), not SSE (mirrors the M1 constraint "push triggers live only in the dispatcher").
- **Prerequisite note (flag before starting Task 8+):** a real Android device or emulator is needed for live verification of the `AccessibilityService`. The Android SDK / emulator may not be installed in this environment — treat this as a checked prerequisite, not an assumption (see Task 8, Step 0).

---

## Task 1: Backend — `device_commands` Prisma model

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (append after the `device_tokens` model, ~line 853)

**Interfaces:**
- Produces: table `device_commands` with columns `id, workspace_id, user_id, status, kind, payload (Json, step-script array), result (Json?), agent_run_id, created_at, updated_at, expires_at`. Task 2 (TOOL_REGISTRY + executor) and Task 3 (proposal service) both write to this table; Task 4 (devices.controller endpoints) reads/writes it; Task 7 (Flutter operator feature) consumes it indirectly via Task 4's endpoints.
- Consumes: nothing new — `agent_run_id` is a bare uuid column (no formal `@relation`), same lightweight-FK convention as `device_tokens.user_id` (avoids cascade complexity for a device-registry-adjacent table).

- [ ] **Step 1: Add the Prisma model**

Append to `packages/db/prisma/schema.prisma` directly after the `device_tokens` model block:

```prisma
// Phone-operator command channel (M3). One row per approved-or-proposed phone
// task. The server agent proposes the step-script (payload); the phone only
// ever executes a command that has reached status 'approved' via the normal
// Approval Center flow (see tool_calls/approvals — phone_task tool). Status is
// a bare String (not a Prisma enum) — same convention as code_tasks.status —
// since this is an internal-only, still-evolving lifecycle list.
model device_commands {
  id           String    @id @default(uuid()) @db.Uuid
  workspace_id String?   @db.Uuid
  user_id      String    @db.Uuid
  agent_run_id String?   @db.Uuid
  // proposed -> awaiting_approval -> approved -> sent -> executing ->
  // succeeded | failed | rejected | expired
  status       String    @default("proposed") @db.VarChar(20)
  kind         String    @db.VarChar(80)
  // Array of {op:'open_app'|'tap'|'type'|'wait'|'assert', ...args}. Adapted
  // from OpenOmniBot's action vocabulary; server-authored, phone-executed only.
  payload      Json      @default("[]")
  // Per-step logs + final outcome, written back by the device after execution.
  // Null until the device POSTs a result. A partial script is never reported
  // as succeeded here — see devices.controller Task 4.
  result       Json?
  created_at   DateTime  @default(now()) @db.Timestamptz(6)
  updated_at   DateTime  @updatedAt @db.Timestamptz(6)
  // TTL guardrail: default now()+15min, set when status becomes 'approved'.
  // Checked lazily (no cron in M3) on every read/write path — see Task 3/4.
  expires_at   DateTime? @db.Timestamptz(6)

  @@index([workspace_id])
  @@index([user_id])
  @@index([status])
  @@index([agent_run_id])
  @@map("device_commands")
}
```

- [ ] **Step 2: Push schema + typecheck**

```bash
pnpm --filter @dynops/db push
pnpm --filter @dynops/api typecheck
```
Expected: both exit 0. (`prisma db push` requires the local/dev database to be reachable — if not running, start it per repo README before this step; do not skip verification.)

- [ ] **Step 3: Commit**

```bash
git add packages/db/prisma/schema.prisma
git commit -m "feat(db): device_commands table for the M3 phone operator"
```

---

## Task 2: Backend — `phone_task` tool in TOOL_REGISTRY

**Files:**
- Modify: `packages/shared/src/tool-intents.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `ToolName` union gains `'phone_task'`; `TOOL_REGISTRY.phone_task = { sensitive: true, risk: 'high', targets: 'internal' }`. Task 3 (executor `executeInternal` branch) and Task 5 (proposal chain) both key off this registry entry; because `sensitive: true`, it is automatically included in `ALWAYS_APPROVE` (derived set, no separate registration needed).

- [ ] **Step 1: Extend `ToolName` union**

In `packages/shared/src/tool-intents.ts`, find the `ToolName` union (currently ends `... | 'bc_create_sales_order' | 'code_task';`) and append `| 'phone_task'`:

```typescript
export type ToolName =
  // ... existing entries unchanged ...
  | 'bc_create_sales_order'
  | 'code_task'
  | 'phone_task';
```

- [ ] **Step 2: Add the TOOL_REGISTRY entry**

Add alongside the other `targets: 'internal'` entries (near `code_task`):

```typescript
phone_task: {
  name: 'phone_task',
  sensitive: true,
  risk: 'high',
  targets: 'internal',
  description:
    'Execute a step-script on the user\'s Android device via the AccessibilityService operator (open_app/tap/type/wait/assert). Always approval; the phone never plans, only executes an already-approved script.',
},
```

- [ ] **Step 3: Typecheck**

```bash
pnpm --filter @dynops/shared typecheck 2>/dev/null || pnpm --filter @dynops/api typecheck
```
Expected: exit 0. `isKnownTool('phone_task')` now returns true; `ALWAYS_APPROVE` includes `phone_task` automatically (derived from `sensitive: true`).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/tool-intents.ts
git commit -m "feat(shared): register phone_task tool (sensitive/high/internal)"
```

---

## Task 3: Backend — phone-task proposal service (agent_run → tool_call → approval → device_commands chain)

**Files:**
- Create: `services/api/src/modules/devices/phone-task.service.ts`
- Modify: `services/api/src/modules/devices/devices.controller.ts` (register `DevicesModule` providers; see Task 4 for the module file itself, which already exists per M1 — this task only adds the new service into it)

**Interfaces:**
- Consumes: `PrismaService`, `tenantStore` (workspace context — this runs inside the API/NestJS process, **not** the worker, so it uses `PrismaService` + `tenantStore.enterWith`-style context, not raw `PrismaClient` — unlike `writeBackToParent` which runs in the worker process; call this out explicitly since the two "propose an approval" call sites use different DI/context patterns).
- Produces: `PhoneTaskService.propose(userId: string, workspaceId: string, opts: { kind: string; steps: PhoneStep[]; reason?: string; ai_resource_id?: string }): Promise<{ device_command_id: string; approval_id: string }>`. This is the function the executor's `executeInternal` branch (Task 5) calls when `tool === 'phone_task'`.

- [ ] **Step 1: Define the step-script shape**

Create `services/api/src/modules/devices/phone-task.types.ts`:

```typescript
// Step-script vocabulary for the phone operator. Adapted from OpenOmniBot's
// action vocabulary. Server-authored only — the Kotlin AccessibilityService
// (Task 8) executes this verbatim; it does not interpret or re-plan.
export type PhoneStep =
  | { op: 'open_app'; package_name: string }
  | { op: 'tap'; selector: { text?: string; content_desc?: string; resource_id?: string }; timeout_ms?: number }
  | { op: 'type'; selector: { text?: string; content_desc?: string; resource_id?: string }; value: string }
  | { op: 'wait'; ms: number }
  | { op: 'assert'; selector: { text?: string; content_desc?: string; resource_id?: string }; expect: 'present' | 'absent' };

export interface PhoneStepResult {
  index: number;
  op: PhoneStep['op'];
  ok: boolean;
  detail?: string;
  duration_ms?: number;
}

export interface PhoneTaskResult {
  ok: boolean; // true only if every step in the script succeeded
  steps: PhoneStepResult[];
  failed_at_index?: number;
}
```

- [ ] **Step 2: Write the proposal service**

Create `services/api/src/modules/devices/phone-task.service.ts`:

```typescript
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { PhoneStep } from './phone-task.types';

const TTL_MS = 15 * 60 * 1000; // spec §3.3 default 15 min, applied at 'approved' time (Task 4)

@Injectable()
export class PhoneTaskService {
  private readonly logger = new Logger(PhoneTaskService.name);

  constructor(private readonly prisma: PrismaService) {}

  // Mirrors services/worker/src/mission.ts's writeBackToParent chain:
  // synthetic agent_run (attribution only) -> tool_call (awaiting_approval)
  // -> approval (pending) -> plus the M3-specific sibling: a device_commands
  // row the executor and the device both key off (args.device_command_id).
  // Never executes anything — this only proposes. Actual execution happens on
  // the device, after a human approves in the Approval Center (Task 4/8).
  async propose(params: {
    userId: string;
    workspaceId: string | null;
    kind: string;
    steps: PhoneStep[];
    reason?: string;
    aiResourceId?: string | null;
    activityId?: string | null; // if this phone task is part of an existing activity thread
  }): Promise<{ deviceCommandId: string; approvalId: string }> {
    const { userId, workspaceId, kind, steps, reason, aiResourceId } = params;

    // 1. Resolve a required activity_id (approvals.activity_id is non-nullable).
    //    If no parent activity was supplied, synthesize a minimal 'manual'
    //    channel activity — same necessity as writeBackToParent resolving a
    //    fallback ai_resource_id for the required agent_runs.ai_resource_id FK.
    let activityId = params.activityId ?? null;
    if (!activityId) {
      const activity = await this.prisma.activities.create({
        data: {
          workspace_id: workspaceId,
          channel: 'manual',
          subject: `Phone task: ${kind}`,
          status: 'awaiting_approval',
          requires_approval: true,
          metadata: { source: 'phone_task' } as any,
        },
      });
      activityId = activity.id;
    }

    // 2. Resolve a required ai_resource_id for the agent_runs FK.
    let resourceId = aiResourceId ?? null;
    if (!resourceId) {
      const anyResource = await this.prisma.ai_resources.findFirst({
        where: { status: 'active', workspace_id: workspaceId ?? undefined },
      });
      if (!anyResource) {
        throw new Error('phone_task propose: no active ai_resource available for agent_run attribution');
      }
      resourceId = anyResource.id;
    }

    // 3. Create the device_commands row FIRST (status 'proposed') so we have
    //    an id to embed in the tool_call args before the approval is created.
    const command = await (this.prisma as any).device_commands.create({
      data: {
        workspace_id: workspaceId,
        user_id: userId,
        status: 'proposed',
        kind,
        payload: steps as any,
      },
    });

    // 4. Synthetic agent_run (attribution only, mirrors writeBackToParent).
    const agentRun = await this.prisma.agent_runs.create({
      data: {
        workspace_id: workspaceId,
        activity_id: activityId,
        ai_resource_id: resourceId,
        llm_provider: 'ollama',
        llm_model: 'qwen3',
        status: 'succeeded',
        input: { device_command_id: command.id, kind } as any,
        output: {} as any,
        tools_used: ['phone_task'] as any,
      },
    });

    // 5. tool_call: status goes straight to awaiting_approval (already known
    //    to require approval — same shortcut writeBackToParent takes).
    const toolCall = await this.prisma.tool_calls.create({
      data: {
        workspace_id: workspaceId,
        agent_run_id: agentRun.id,
        name: 'phone_task',
        args: { device_command_id: command.id, kind, steps } as any,
        requires_approval: true,
        risk_level: 'high',
        status: 'awaiting_approval',
        sequence: 0,
      },
    });

    // 6. approval: pending, TTL-independent expiry (approval itself uses the
    //    existing 7-day-ish convention; the device_commands TTL is separate
    //    and starts only once this approval is granted — see Task 4).
    const approval = await this.prisma.approvals.create({
      data: {
        workspace_id: workspaceId,
        activity_id: activityId,
        agent_run_id: agentRun.id,
        tool_call_id: toolCall.id,
        action: 'phone_task',
        payload: { device_command_id: command.id, kind, steps } as any,
        risk_level: 'high',
        reason: reason ?? `Phone task: ${kind}`,
        status: 'pending',
      },
    });

    // 7. Link the command back to its agent_run for traceability.
    await (this.prisma as any).device_commands.update({
      where: { id: command.id },
      data: { status: 'awaiting_approval', agent_run_id: agentRun.id },
    });

    this.logger.log(`Proposed phone_task ${command.id} (${kind}) -> approval ${approval.id}`);
    return { deviceCommandId: command.id, approvalId: approval.id };
  }
}

export { TTL_MS };
```

- [ ] **Step 4: Register the provider**

In `services/api/src/modules/devices/devices.module.ts` (create if it does not already exist as a separate file — per M1, `DevicesModule` was declared inline in `devices.controller.ts`; if so, extract the `@Module` decorator to its own file here so `PhoneTaskService` and the executor can both import it cleanly):

```typescript
import { Module } from '@nestjs/common';
import { DevicesController } from './devices.controller';
import { PhoneTaskService } from './phone-task.service';

@Module({
  controllers: [DevicesController],
  providers: [PhoneTaskService],
  exports: [PhoneTaskService],
})
export class DevicesModule {}
```

Remove the inline `@Module` block from `devices.controller.ts` if it was declared there (per M1's Task 1 pattern), and update `services/api/src/app.module.ts`'s import path if it pointed at the controller file directly.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @dynops/api typecheck
```
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/modules/devices/
git commit -m "feat(api): PhoneTaskService — propose phone_task as agent_run/tool_call/approval chain"
```

---

## Task 4: Backend — devices.controller command endpoints + approval-hook (approve → push)

**Files:**
- Modify: `services/api/src/modules/devices/devices.controller.ts`
- Modify: `services/api/src/modules/approvals/approvals.service.ts` (hook: on approval of a `phone_task` tool_call, flip `device_commands.status` and enqueue the silent push)
- Modify: `services/api/src/integrations/push/fcm.ts` (add a data-only/silent send helper)

**Interfaces:**
- Consumes: `PhoneTaskService` (Task 3, for the `device_commands` update logic reused here), `sendFcm` (existing push client), `tenantStore`, `CurrentUser`/`AuthUser`/`Roles` decorators (same as `approvals.controller.ts`).
- Produces:
  - `GET /api/v1/devices/commands?status=approved` → `{commands: DeviceCommand[]}` scoped to the caller's own `user_id` + workspace.
  - `POST /api/v1/devices/commands/:id/result` `{status: 'succeeded'|'failed', steps: PhoneStepResult[], detail?: string}` → `{ok: true}`, writes back `result` + terminal `status`, audited.
  - Task 7 (Flutter operator repository) consumes both endpoints directly.

**Design note (spec deviation, intentional):** the spec's approval flow says "On approval: status approved → silent data-push (`command_ready`)". Rather than adding a new watermark-scan block to `PushDispatcherService.tick()` (which would add up to `PUSH_TICK_MS` / 20s latency — acceptable for approvals/notifications, but this is a one-shot event tightly coupled to a specific approval action), this task sends the push **synchronously inline** in `ApprovalsService.approve()` right after the `device_commands` row flips to `approved` — same "call directly, no queue" shape as `writeBackToParent`'s style of doing everything inline and swallowing errors. This keeps the push send in the same request/response cycle as the approval action, with a non-critical try/catch (a push failure must never fail the approval itself).

- [ ] **Step 1: Add a silent/data-only push helper**

In `services/api/src/integrations/push/fcm.ts`, add a sibling function alongside the existing `sendFcm` (which always includes a `notification` block and thus always shows a visible OS notification). Silent pushes must omit the `notification` field entirely so no OS banner appears:

```typescript
// Data-only (silent) push — no visible OS notification. Used to wake the app
// to fetch a newly-approved phone command without alerting the user twice
// (they already saw/acted on the approval in the Approval Center or web).
export async function sendFcmSilent(
  deviceToken: string,
  data: Record<string, string>,
): Promise<'ok' | 'unregistered' | 'error'> {
  if (!fcmConfigured()) {
    console.log(`(mock) silent push → [${data.type ?? '?'}:${data.id ?? '?'}]`);
    return 'ok';
  }
  const sa = getServiceAccount(); // reuse existing internal helper from this file
  const token = await getAccessToken(sa); // reuse existing internal helper
  try {
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa!.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      // Android-specific priority hint so the data message wakes a backgrounded
      // app promptly (data-only messages otherwise default to normal priority).
      body: JSON.stringify({
        message: { token: deviceToken, data, android: { priority: 'high' } },
      }),
    });
    if (res.status === 404 || res.status === 400) return 'unregistered';
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}
```

(Adjust `getServiceAccount`/`getAccessToken` names to whatever the existing private helpers in `fcm.ts` are actually called — reuse them, do not duplicate the OAuth token logic.)

- [ ] **Step 2: Add a workspace+user push-to-devices helper**

In `services/api/src/modules/devices/devices.controller.ts` (or a small new `devices.service.ts` if the controller is getting large — prefer a service to keep the controller thin, consistent with `approvals.controller.ts` delegating to `approvals.service.ts`):

```typescript
// Push a silent 'command' data message to every device_token belonging to
// this user (a user may be logged in on multiple devices; all get woken).
async function pushCommandReady(prisma: PrismaService, userId: string, commandId: string) {
  const tokens = await (prisma as any).device_tokens.findMany({ where: { user_id: userId } });
  for (const t of tokens) {
    const result = await sendFcmSilent(t.token, { type: 'command', id: commandId });
    if (result === 'unregistered') {
      await (prisma as any).device_tokens.deleteMany({ where: { token: t.token } });
    }
  }
}
```

- [ ] **Step 3: Hook into `ApprovalsService.approve()`**

In `services/api/src/modules/approvals/approvals.service.ts`, inside `approve()`, after the existing `executeToolCall` call and before/alongside `advanceActivity`, add the phone_task-specific branch. This does **not** call `executeToolCall`'s normal internal-tool path for execution — the tool_call's `executeInternal` branch (Task 5) is a no-op/attribution-only step for `phone_task`; the actual state transition + push happens here because it needs the approval's own context:

```typescript
// After: await this.prisma.tool_calls.update({ ...status: 'approved' });
//        executed = await this.executor.executeToolCall(approval.tool_call_id, user.id);
if (approval.action === 'phone_task' && approval.tool_call) {
  const args = (approval.tool_call.args as any) ?? {};
  const commandId = args.device_command_id as string | undefined;
  if (commandId) {
    try {
      const cmd = await (this.prisma as any).device_commands.update({
        where: { id: commandId },
        data: { status: 'approved', expires_at: new Date(Date.now() + 15 * 60 * 1000) },
      });
      await pushCommandReady(this.prisma, cmd.user_id, commandId);
    } catch (e) {
      // Non-critical: the app also polls; a push failure must not fail the approval.
      console.warn(`[approvals] phone_task push failed for ${commandId}:`, (e as Error).message);
    }
  }
}
```

- [ ] **Step 4: `GET /devices/commands` endpoint**

In `services/api/src/modules/devices/devices.controller.ts`, add:

```typescript
@Get('commands')
async listCommands(@Query('status') status: string | undefined, @CurrentUser() user: AuthUser) {
  const wsId = tenantStore.getStore()?.workspaceId ?? null;
  const where: any = { user_id: user.id };
  if (wsId) where.workspace_id = wsId;
  if (status) where.status = status;
  const rows = await (this.prisma as any).device_commands.findMany({
    where,
    orderBy: { created_at: 'desc' },
    take: 50,
  });
  // Lazy TTL check: flip any stale 'approved' rows to 'expired' before returning.
  const now = new Date();
  const fresh = [];
  for (const r of rows) {
    if (r.status === 'approved' && r.expires_at && r.expires_at < now) {
      await (this.prisma as any).device_commands.update({ where: { id: r.id }, data: { status: 'expired' } });
      r.status = 'expired';
    }
    if (!status || r.status === status) fresh.push(r);
  }
  return { commands: fresh };
}
```

- [ ] **Step 5: `POST /devices/commands/:id/result` endpoint**

```typescript
@Post('commands/:id/result')
async postResult(
  @Param('id') id: string,
  @Body() body: { status: 'succeeded' | 'failed'; steps: any[]; detail?: string },
  @CurrentUser() user: AuthUser,
) {
  const cmd = await (this.prisma as any).device_commands.findUnique({ where: { id } });
  if (!cmd || cmd.user_id !== user.id) return { ok: false, detail: 'not found' };
  // Guardrail: never let a partial/ambiguous report count as succeeded.
  const allStepsOk = Array.isArray(body.steps) && body.steps.every((s) => s.ok === true);
  const finalStatus = body.status === 'succeeded' && allStepsOk ? 'succeeded' : 'failed';
  await (this.prisma as any).device_commands.update({
    where: { id },
    data: {
      status: finalStatus,
      result: { ok: finalStatus === 'succeeded', steps: body.steps, detail: body.detail } as any,
    },
  });
  // Audit — reuse the same audit service other approval-adjacent writes use.
  await this.audit.log({
    actorType: 'user',
    actorUserId: user.id,
    action: finalStatus,
    entityType: 'device_commands',
    entityId: id,
    summary: `Phone task ${cmd.kind}: ${finalStatus}`,
  });
  return { ok: true };
}
```

(Wire `AuditService` into `DevicesController`'s constructor if not already present — same DI pattern as `ApprovalsService`.)

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @dynops/api typecheck
```
Expected: exit 0.

- [ ] **Step 7: Live verification — full propose → approve → fetch → result loop**

```bash
docker compose build api && docker compose up -d api
until docker compose logs api 2>&1 | tail -20 | grep -q "API listening on :4000"; do sleep 3; done

TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login -H 'content-type: application/json' -d '{"email":"admin@dynamicsops.com"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
WS=$(curl -s http://localhost:4000/api/v1/workspaces -H "authorization: Bearer $TOKEN" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)

# Register a device token so the push fires (mock-mode is fine — no FCM creds needed).
curl -s -X POST http://localhost:4000/api/v1/devices/register -H "authorization: Bearer $TOKEN" -H "x-workspace: $WS" -H 'content-type: application/json' -d '{"platform":"android","token":"m3-test-token"}'

# There is no public "propose" HTTP endpoint by design (only the agent pipeline
# proposes phone_task) — simulate the proposal directly via psql for this
# verification pass, mirroring how the mission write-back chain is only
# reachable from worker code, not a REST endpoint.
docker compose exec -T postgres psql -U dynops -d dynops -c "
  -- (illustrative) confirm the tables exist and are empty before the loop
  SELECT count(*) FROM device_commands;
"

# Instead, verify end-to-end via the actual executor call path:
# trigger a phone_task tool_call through whatever dev/test harness the repo
# already uses to enqueue agent tool intents (see services/worker tests, or
# call PhoneTaskService.propose(...) from a scratch script) — then:

APPROVAL_ID=$(docker compose exec -T postgres psql -U dynops -d dynops -t -c "SELECT id FROM approvals WHERE action='phone_task' ORDER BY created_at DESC LIMIT 1;" | tr -d ' ')
curl -s -X POST "http://localhost:4000/api/v1/approvals/$APPROVAL_ID/approve" -H "authorization: Bearer $TOKEN" -H "x-workspace: $WS" -H 'content-type: application/json' -d '{}'

docker compose logs api 2>&1 | tail -20 | grep -q "(mock) silent push" && echo "PUSH OK"

CMD_ID=$(curl -s "http://localhost:4000/api/v1/devices/commands?status=approved" -H "authorization: Bearer $TOKEN" -H "x-workspace: $WS" | sed -n 's/.*"id":"\([^"]*\)".*/\1/p' | head -1)
curl -s -X POST "http://localhost:4000/api/v1/devices/commands/$CMD_ID/result" -H "authorization: Bearer $TOKEN" -H "x-workspace: $WS" -H 'content-type: application/json' -d '{"status":"succeeded","steps":[{"index":0,"op":"open_app","ok":true}]}'

docker compose exec -T postgres psql -U dynops -d dynops -c "SELECT id, status FROM device_commands WHERE id='$CMD_ID';"
```
Expected: `phone_task` approval flips to `approved`; `device_commands.status` flips `awaiting_approval → approved`; mock push log line appears; `GET /devices/commands?status=approved` returns the row; `POST .../result` flips it to `succeeded`; final psql shows `succeeded`.

- [ ] **Step 8: Commit**

```bash
git add services/api/src/modules/devices/ services/api/src/modules/approvals/approvals.service.ts services/api/src/integrations/push/fcm.ts
git commit -m "feat(api): device_commands lifecycle endpoints + approval-triggered silent push"
```

---

## Task 5: Backend — executor `phone_task` branch (attribution/no-op) + audit

**Files:**
- Modify: `services/api/src/integrations/executor.service.ts`

**Interfaces:**
- Consumes: nothing new beyond what `executeInternal` already has access to.
- Produces: `executeInternal` handles `tool === 'phone_task'` without doing any real work — the actual state transition already happened in Task 4's `approve()` hook (because it needs the approval's own `device_command_id` context to update). This branch exists only so `executeToolCall`'s dispatch doesn't fall through to the generic `{ok:true, detail: '(internal, no-op)'}` fallback silently and so the `tool_calls.result` gets a meaningful value for the Approval Center detail view.

**Design note (spec deviation, intentional):** unlike `code_task` (whose executor branch does the real work — calling `runCodeTask`), `phone_task`'s real "did it work" state lives entirely on the device (execution happens on the phone, potentially minutes after approval). The executor branch here is deliberately thin — it only echoes back the current `device_commands` status so the Approval Center's "executed" field shows something meaningful immediately (`approved`, not a final outcome), rather than blocking the approval response waiting for the phone to finish.

- [ ] **Step 1: Add the branch**

In `services/api/src/integrations/executor.service.ts`, inside `executeInternal`, add (alongside the existing `code_task` branch):

```typescript
if (tool === 'phone_task') {
  const commandId = args.device_command_id as string | undefined;
  if (!commandId) return { ok: false, detail: 'phone_task missing device_command_id' };
  const cmd = await (this.prisma as any).device_commands.findUnique({ where: { id: commandId } });
  return {
    ok: true,
    detail: `Phone task queued for device execution (status: ${cmd?.status ?? 'unknown'})`,
    result: { device_command_id: commandId, status: cmd?.status ?? 'unknown' },
  };
}
```

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @dynops/api typecheck
```
Expected: exit 0.

- [ ] **Step 3: Commit**

```bash
git add services/api/src/integrations/executor.service.ts
git commit -m "feat(api): executor phone_task branch — attribution echo, real state lives on device_commands"
```

---

## Task 6: Flutter — API client + push routing extensions (no new deps)

**Files:**
- Modify: `apps/mobile/lib/core/push.dart` (extend the `type` discriminator with `'command'`)
- Create: `apps/mobile/lib/features/operator/operator_models.dart`
- Create: `apps/mobile/lib/features/operator/operator_repository.dart`

**Interfaces:**
- Consumes: `ApiClient.get`/`.post` (existing, `apps/mobile/lib/core/api.dart`), `unwrapList()` helper (existing, from `approvals_models.dart` — reuse rather than re-implement), the existing Riverpod `sessionProvider`.
- Produces: `DeviceCommand` model (`id, status, kind, payload, result, createdAt, expiresAt`), `operatorCommandsProvider` (FutureProvider.autoDispose, `GET /devices/commands?status=approved`), `OperatorActions.postResult(id, status, steps, detail)` (`POST /devices/commands/:id/result`). Task 7 (operator screens) and Task 8 (Kotlin bridge glue in Dart) both consume these.

- [ ] **Step 1: Extend push routing for the `command` type**

In `apps/mobile/lib/core/push.dart`, extend the existing `route()` function's discriminator (currently `if (type == 'approval') ... ; if (type == 'notification') ...`):

```dart
void route(RemoteMessage m) {
  final type = m.data['type'];
  final id = m.data['id'];
  if (id == null) return;
  if (type == 'approval') router.push('/approvals/$id');
  if (type == 'notification') router.go('/inbox');
  if (type == 'command') router.push('/operator/commands/$id');
}
```

Also add a **foreground** listener for the silent `command` push — this is new: today there is no `FirebaseMessaging.onMessage` (foreground) handler at all (only `onMessageOpenedApp` + `getInitialMessage`, both tap-driven). A data-only push arriving while the app is foregrounded needs a foreground listener to trigger a silent refresh of the operator inbox (no OS banner, no navigation — just invalidate the provider so the list updates if the user is already on that screen):

```dart
// Foreground data-only messages never show an OS banner and never fire
// onMessageOpenedApp (the user never "opened" anything — the app was already
// open). This is new: M1/M2 only handled background-tap routing.
FirebaseMessaging.onMessage.listen((m) {
  if (m.data['type'] == 'command') {
    // Consumers (operator_repository.dart, Task 7) invalidate their own
    // provider via a ref passed at initPush call-time, or via a simple
    // ValueNotifier/StreamController bridge — keep this minimal, no new deps.
    onCommandPush?.call(m.data['id'] as String?);
  }
});
```

Add a top-level `void Function(String? id)? onCommandPush;` callback variable in `push.dart` that `main.dart`/the operator feature wires up at app start (mirrors the existing simple-callback style already used for `route`/`router` — no new state-management dependency needed).

- [ ] **Step 2: Operator models**

Create `apps/mobile/lib/features/operator/operator_models.dart`:

```dart
class DeviceCommand {
  DeviceCommand({
    required this.id,
    required this.status,
    required this.kind,
    required this.payload,
    required this.createdAt,
    this.expiresAt,
    this.result,
  });

  final String id;
  final String status; // proposed|awaiting_approval|approved|sent|executing|succeeded|failed|rejected|expired
  final String kind;
  final List<dynamic> payload; // step-script: array of {op, ...args}
  final Map<String, dynamic>? result;
  final DateTime createdAt;
  final DateTime? expiresAt;

  factory DeviceCommand.fromJson(Map<String, dynamic> j) => DeviceCommand(
        id: j['id'] as String,
        status: j['status'] as String,
        kind: j['kind'] as String,
        payload: (j['payload'] as List?) ?? const [],
        result: (j['result'] as Map?)?.cast<String, dynamic>(),
        createdAt: DateTime.parse(j['created_at'] as String),
        expiresAt: j['expires_at'] != null ? DateTime.parse(j['expires_at'] as String) : null,
      );
}
```

- [ ] **Step 3: Operator repository (providers + API calls)**

Create `apps/mobile/lib/features/operator/operator_repository.dart` (mirrors `approvals_repository.dart`'s shape exactly: a list provider + an actions class):

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../approvals/approvals_models.dart' show unwrapList;
import '../../core/session.dart'; // adjust import to the actual session provider location
import 'operator_models.dart';

final operatorCommandsProvider = FutureProvider.autoDispose<List<DeviceCommand>>((ref) async {
  final api = ref.read(sessionProvider)!.api;
  final body = await api.get('/devices/commands', query: {'status': 'approved'});
  return unwrapList(body, key: 'commands').map((e) => DeviceCommand.fromJson(e)).toList();
});

class OperatorActions {
  OperatorActions(this._ref);
  final Ref _ref;

  Future<void> postResult(String id, {required bool succeeded, required List<Map<String, dynamic>> steps, String? detail}) async {
    final api = _ref.read(sessionProvider)!.api;
    await api.post('/devices/commands/$id/result', body: {
      'status': succeeded ? 'succeeded' : 'failed',
      'steps': steps,
      if (detail != null) 'detail': detail,
    });
  }
}

final operatorActionsProvider = Provider((ref) => OperatorActions(ref));
```

(Confirm the exact `unwrapList` signature in `approvals_models.dart` — it may take a positional key argument rather than named; match its real signature rather than the illustrative one above.)

- [ ] **Step 4: Verify**

```bash
cd apps/mobile && flutter analyze
```
Expected: no new errors (some "unused provider" info-level lints are fine until Task 7 wires up the UI).

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/core/push.dart apps/mobile/lib/features/operator/
git commit -m "feat(mobile): operator repository + command push-routing (foreground + background)"
```

---

## Task 7: Flutter — operator feature UI (inbox, execution status, permissions onboarding), Android-only entry point

**Files:**
- Create: `apps/mobile/lib/features/operator/operator_screen.dart` (device-command inbox — approved commands awaiting execution)
- Create: `apps/mobile/lib/features/operator/operator_detail_screen.dart` (single command: step-script preview, execution status, per-step log after run)
- Create: `apps/mobile/lib/features/operator/operator_onboarding_screen.dart` (explicit-consent AccessibilityService permission flow)
- Modify: `apps/mobile/lib/shell.dart` (Android-only 6th nav entry, or nest under the existing "Daha" more-menu per spec §2's nav layout — spec says operator lives "under Daha", not as a top-level tab)
- Modify: router registration file (wherever `GoRoute`s are declared — same file M1's Task 3 added `/chat` to)

**Interfaces:**
- Consumes: `operatorCommandsProvider`, `operatorActionsProvider` (Task 6), a new platform-channel client `OperatorChannel` (Task 8 defines the Kotlin side; this task defines the Dart-side `MethodChannel` caller).
- Produces: routes `/operator` (onboarding-gated inbox), `/operator/commands/:id` (detail — this is also the push deep-link target from Task 6's `route()`).

- [ ] **Step 1: Onboarding/permissions screen**

Create `apps/mobile/lib/features/operator/operator_onboarding_screen.dart`. This is the **explicit-consent gate** — the spec is emphatic that AccessibilityService is powerful and requires an explicit opt-in, not an incidental permission prompt:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'operator_channel.dart';

const _consentKey = 'dynops_operator_consent_v1';

class OperatorOnboardingScreen extends StatefulWidget {
  const OperatorOnboardingScreen({super.key, required this.onConsented});
  final VoidCallback onConsented;

  @override
  State<OperatorOnboardingScreen> createState() => _OperatorOnboardingScreenState();
}

class _OperatorOnboardingScreenState extends State<OperatorOnboardingScreen> {
  bool _accessibilityEnabled = false;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    final enabled = await OperatorChannel.isAccessibilityServiceEnabled();
    setState(() => _accessibilityEnabled = enabled);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Telefon Operatörü')),
      body: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Bu özellik, YALNIZCA sizin onayladığınız görevleri telefonunuzda '
              'çalıştırır. Sunucudaki AI hiçbir zaman telefonunuzda plan yapmaz '
              've siz onaylamadan hiçbir adım çalışmaz.',
            ),
            const SizedBox(height: 24),
            Text(_accessibilityEnabled ? 'Erişilebilirlik servisi: Açık' : 'Erişilebilirlik servisi: Kapalı'),
            const SizedBox(height: 12),
            if (!_accessibilityEnabled)
              ElevatedButton(
                onPressed: () async {
                  await OperatorChannel.openAccessibilitySettings();
                  await _check();
                },
                child: const Text('Erişilebilirlik Ayarlarını Aç'),
              ),
            const SizedBox(height: 24),
            ElevatedButton(
              onPressed: _accessibilityEnabled
                  ? () async {
                      await const FlutterSecureStorage().write(key: _consentKey, value: 'granted');
                      widget.onConsented();
                    }
                  : null,
              child: const Text('Onaylıyorum ve Etkinleştiriyorum'),
            ),
          ],
        ),
      ),
    );
  }
}

Future<bool> hasOperatorConsent() async {
  final v = await const FlutterSecureStorage().read(key: _consentKey);
  return v == 'granted';
}
```

- [ ] **Step 2: Inbox screen**

Create `apps/mobile/lib/features/operator/operator_screen.dart` (mirrors `approvals_screen.dart`'s list-screen shape):

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'operator_repository.dart';
import 'operator_onboarding_screen.dart';

class OperatorScreen extends ConsumerWidget {
  const OperatorScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return FutureBuilder<bool>(
      future: hasOperatorConsent(),
      builder: (context, snap) {
        if (!snap.hasData) return const Center(child: CircularProgressIndicator());
        if (snap.data == false) {
          return OperatorOnboardingScreen(onConsented: () => (context as Element).markNeedsBuild());
        }
        final commands = ref.watch(operatorCommandsProvider);
        return Scaffold(
          appBar: AppBar(title: const Text('Telefon Görevleri')),
          body: commands.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Text('Hata: $e')),
            data: (list) => list.isEmpty
                ? const Center(child: Text('Onaylanmış görev yok'))
                : ListView.builder(
                    itemCount: list.length,
                    itemBuilder: (context, i) {
                      final c = list[i];
                      return ListTile(
                        title: Text(c.kind),
                        subtitle: Text('${c.payload.length} adım · ${c.status}'),
                        trailing: Text(c.expiresAt != null ? 'TTL: ${c.expiresAt}' : ''),
                        onTap: () => context.push('/operator/commands/${c.id}'),
                      );
                    },
                  ),
          ),
        );
      },
    );
  }
}
```

- [ ] **Step 3: Detail/execution screen**

Create `apps/mobile/lib/features/operator/operator_detail_screen.dart` — shows the step-script for review, an optional biometric-confirm gate (see Task 9 for the `local_auth` wiring), an "Execute" button that calls the Kotlin bridge (Task 8), a live per-step progress list, and posts the result on completion via `OperatorActions.postResult`. Full step-by-step UI logic is implemented in Task 9 alongside the platform-channel wiring (this step scaffolds the screen and its route only, with a placeholder "Execute" button that Task 9 fills in):

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'operator_repository.dart';

class OperatorDetailScreen extends ConsumerWidget {
  const OperatorDetailScreen({super.key, required this.commandId});
  final String commandId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final commands = ref.watch(operatorCommandsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Görev Detayı')),
      body: commands.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (list) {
          final cmd = list.where((c) => c.id == commandId).firstOrNull;
          if (cmd == null) return const Center(child: Text('Görev bulunamadı veya süresi doldu'));
          return ListView(
            padding: const EdgeInsets.all(16),
            children: [
              Text(cmd.kind, style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: 12),
              const Text('Adımlar (sunucu tarafından planlandı, sadece onay sonrası çalışır):'),
              for (final step in cmd.payload) ListTile(dense: true, title: Text(step.toString())),
              const SizedBox(height: 24),
              // Task 9 replaces this with the real execute-via-platform-channel flow.
              ElevatedButton(onPressed: null, child: Text('Çalıştır (Task 9\'da bağlanacak)')),
            ],
          );
        },
      ),
    );
  }
}
```

- [ ] **Step 4: Wire the Android-only nav entry**

In `apps/mobile/lib/shell.dart`, per spec §2 ("dashboard/settings/operator nested under Daha" — not a top-level tab), add the operator entry to whatever "Daha" (More) menu screen already exists (created in M1's Task 5 shell work) rather than the 5-tab `_tabs` list itself. If the "Daha" screen is a simple list of `ListTile`s, add (Android-only guard):

```dart
import 'dart:io' show Platform;
// ... inside the "Daha" screen's build method, in its ListView children:
if (Platform.isAndroid)
  ListTile(
    leading: const Icon(Icons.smart_toy_outlined),
    title: const Text('Telefon Operatörü'),
    onTap: () => context.push('/operator'),
  ),
```

- [ ] **Step 5: Register routes**

In the router file (wherever `/chat`, `/approvals`, etc. are declared as `GoRoute`s), add:

```dart
GoRoute(path: '/operator', builder: (_, __) => const OperatorScreen()),
GoRoute(
  path: '/operator/commands/:id',
  builder: (_, state) => OperatorDetailScreen(commandId: state.pathParameters['id']!),
),
```

- [ ] **Step 6: Verify**

```bash
cd apps/mobile && flutter analyze && flutter test
```
Expected: clean analyze, all tests pass. (`OperatorChannel.isAccessibilityServiceEnabled()`/`openAccessibilitySettings()` referenced here don't exist yet — Task 8 creates `operator_channel.dart`; if Task 7 is executed before Task 8, stub `operator_channel.dart` minimally first so `flutter analyze` passes, then flesh it out in Task 8.)

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/lib/features/operator/ apps/mobile/lib/shell.dart
git commit -m "feat(mobile): operator feature UI — onboarding, inbox, detail (Android-only entry)"
```

---

## Task 8: Android (Kotlin) — AccessibilityService executor + MethodChannel bridge

**Files:**
- Modify: `apps/mobile/android/app/src/main/AndroidManifest.xml` (declare the service + `BIND_ACCESSIBILITY_SERVICE` permission + a config XML resource)
- Create: `apps/mobile/android/app/src/main/res/xml/accessibility_service_config.xml`
- Create: `apps/mobile/android/app/src/main/kotlin/com/dynamicsops/dynops_mobile/OperatorAccessibilityService.kt`
- Create: `apps/mobile/android/app/src/main/kotlin/com/dynamicsops/dynops_mobile/OperatorStepExecutor.kt`
- Modify: `apps/mobile/android/app/src/main/kotlin/com/dynamicsops/dynops_mobile/MainActivity.kt` (register the `MethodChannel` — currently empty, first platform channel in this app)
- Create: `apps/mobile/lib/features/operator/operator_channel.dart` (Dart-side `MethodChannel` client)

**Interfaces:**
- Consumes: nothing external — this is new native surface.
- Produces (Dart↔Kotlin `MethodChannel`, channel name `com.dynamicsops.dynops_mobile/operator`):
  - Dart → Kotlin: `isAccessibilityServiceEnabled() -> bool`, `openAccessibilitySettings() -> void`, `executeSteps(List<Map> steps) -> List<Map>` (per-step results, returned once the whole script finishes or fails).
  - Kotlin → Dart: none needed for M3 (no streaming step-by-step progress over the channel in this plan — the whole script runs then returns; a future increment could add an `EventChannel` for live progress, out of scope here per YAGNI).

- [ ] **Step 0: Verify Android SDK / emulator availability (prerequisite check — do this first)**

```bash
which adb || echo "ANDROID SDK NOT FOUND — see risk note below"
flutter doctor -v | grep -A5 "Android toolchain"
```
If the Android SDK/emulator is not installed, **stop and flag this to the user** before attempting any device-dependent step in this task — do not silently skip live verification; note it as a blocked prerequisite in the final report instead. (Flutter itself is expected at `~/development/flutter` per existing environment notes; this step is specifically about the Android SDK/emulator, which is a separate install.)

- [ ] **Step 1: Manifest — permission + service declaration**

In `apps/mobile/android/app/src/main/AndroidManifest.xml`, add inside `<application>`:

```xml
<service
    android:name=".OperatorAccessibilityService"
    android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE"
    android:exported="false">
    <intent-filter>
        <action android:name="android.accessibilityservice.AccessibilityService" />
    </intent-filter>
    <meta-data
        android:name="android.accessibilityservice"
        android:resource="@xml/accessibility_service_config" />
</service>
```

No new `<uses-permission>` is needed for the service declaration itself (accessibility services are enabled by the user in system Settings, not granted via the normal runtime-permission dialog) — but do add, if not already present, `android.permission.QUERY_ALL_PACKAGES` only if `open_app` needs to resolve arbitrary package names by label rather than exact package id (prefer requiring exact `package_name` in the step-script to avoid needing this broad permission at all — **do not add `QUERY_ALL_PACKAGES` unless a concrete need surfaces during Task 8 Step 3 implementation**, since it is a Play-policy-sensitive permission even for internal builds' habits going forward).

- [ ] **Step 2: Accessibility service config XML**

Create `apps/mobile/android/app/src/main/res/xml/accessibility_service_config.xml`:

```xml
<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
    android:accessibilityEventTypes="typeAllMask"
    android:accessibilityFlags="flagDefault|flagReportViewIds|flagRetrieveInteractiveWindows"
    android:accessibilityFeedbackType="feedbackGeneric"
    android:canPerformGestures="true"
    android:canRetrieveWindowContent="true"
    android:notificationTimeout="100"
    android:description="@string/operator_accessibility_description" />
```

Add the `operator_accessibility_description` string to `res/values/strings.xml` (create the file if it doesn't exist), explaining plainly what the service does and that it only runs approved tasks — this string is shown to the user in system Settings, so it must be accurate and reassuring, not generic boilerplate.

- [ ] **Step 3: The `AccessibilityService` + step executor**

Create `apps/mobile/android/app/src/main/kotlin/com/dynamicsops/dynops_mobile/OperatorAccessibilityService.kt`:

```kotlin
package com.dynamicsops.dynops_mobile

import android.accessibilityservice.AccessibilityService
import android.accessibilityservice.GestureDescription
import android.content.Intent
import android.graphics.Path
import android.view.accessibility.AccessibilityEvent
import android.view.accessibility.AccessibilityNodeInfo

// Server-driven, approval-gated executor. This service NEVER decides what to
// do — it only runs the step array it is handed via MainActivity's
// MethodChannel bridge, one step at a time, and reports back per-step
// results. It does not observe/react to arbitrary screen events beyond what
// each step's own timeout/assert needs (no always-on scanning, no vision/OCR,
// no screenshot capture — per spec §3.3 "screenshot capture off by default").
class OperatorAccessibilityService : AccessibilityService() {

    companion object {
        // MainActivity reads this to answer isAccessibilityServiceEnabled()
        // without depending on Settings.Secure parsing races.
        var instance: OperatorAccessibilityService? = null
    }

    override fun onServiceConnected() {
        super.onServiceConnected()
        instance = this
    }

    override fun onDestroy() {
        instance = null
        super.onDestroy()
    }

    override fun onAccessibilityEvent(event: AccessibilityEvent?) {
        // Intentionally empty: this service does not react autonomously to
        // events. Step execution (findNode/tap/type/assert) reads window
        // content on-demand via rootInActiveWindow, not via this callback.
    }

    override fun onInterrupt() {}

    // Runs one step at a time; suspend/blocking-with-timeout style, called
    // from a background thread by MainActivity's MethodChannel handler.
    fun findNode(selector: Map<String, String?>): AccessibilityNodeInfo? {
        val root = rootInActiveWindow ?: return null
        selector["resource_id"]?.let { id ->
            root.findAccessibilityNodeInfosByViewId(id).firstOrNull()?.let { return it }
        }
        selector["text"]?.let { text ->
            root.findAccessibilityNodeInfosByText(text).firstOrNull()?.let { return it }
        }
        // content_desc has no direct finder API; fall back to a tree walk.
        selector["content_desc"]?.let { desc ->
            return findByContentDescription(root, desc)
        }
        return null
    }

    private fun findByContentDescription(node: AccessibilityNodeInfo, desc: String): AccessibilityNodeInfo? {
        if (node.contentDescription?.toString() == desc) return node
        for (i in 0 until node.childCount) {
            node.getChild(i)?.let { child ->
                findByContentDescription(child, desc)?.let { return it }
            }
        }
        return null
    }

    fun tapNode(node: AccessibilityNodeInfo): Boolean {
        val bounds = android.graphics.Rect()
        node.getBoundsInScreen(bounds)
        val path = Path().apply { moveTo(bounds.centerX().toFloat(), bounds.centerY().toFloat()) }
        val gesture = GestureDescription.Builder()
            .addStroke(GestureDescription.StrokeDescription(path, 0, 50))
            .build()
        var result = false
        val latch = java.util.concurrent.CountDownLatch(1)
        dispatchGesture(gesture, object : GestureResultCallback() {
            override fun onCompleted(gestureDescription: GestureDescription?) {
                result = true; latch.countDown()
            }
            override fun onCancelled(gestureDescription: GestureDescription?) {
                result = false; latch.countDown()
            }
        }, null)
        latch.await(3, java.util.concurrent.TimeUnit.SECONDS)
        return result
    }

    fun typeIntoNode(node: AccessibilityNodeInfo, value: String): Boolean {
        val args = android.os.Bundle()
        args.putCharSequence(AccessibilityNodeInfo.ACTION_ARGUMENT_SET_TEXT_CHARSEQUENCE, value)
        return node.performAction(AccessibilityNodeInfo.ACTION_SET_TEXT, args)
    }

    fun openApp(packageName: String): Boolean {
        val intent = packageManager.getLaunchIntentForPackage(packageName) ?: return false
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        startActivity(intent)
        return true
    }
}
```

Create `apps/mobile/android/app/src/main/kotlin/com/dynamicsops/dynops_mobile/OperatorStepExecutor.kt` — the orchestrator that runs the whole script and produces the per-step result array, enforcing the "never silently report partial success" guardrail:

```kotlin
package com.dynamicsops.dynops_mobile

// Runs a full step-script sequentially against the connected
// OperatorAccessibilityService instance. Stops at the first failed step
// (fail-fast) — a partially executed script is reported as failed overall,
// with the successful prefix of steps recorded in the result array, never
// silently upgraded to "succeeded".
class OperatorStepExecutor(private val service: OperatorAccessibilityService) {

    data class StepResult(val index: Int, val op: String, val ok: Boolean, val detail: String? = null)

    fun run(steps: List<Map<String, Any?>>): List<StepResult> {
        val results = mutableListOf<StepResult>()
        for ((i, step) in steps.withIndex()) {
            val op = step["op"] as? String ?: "unknown"
            val ok = try {
                when (op) {
                    "open_app" -> service.openApp(step["package_name"] as String)
                    "tap" -> {
                        val selector = (step["selector"] as? Map<String, String?>) ?: emptyMap()
                        val node = service.findNode(selector) ?: return failFrom(results, i, op, "node not found").also { return it }
                        service.tapNode(node)
                    }
                    "type" -> {
                        val selector = (step["selector"] as? Map<String, String?>) ?: emptyMap()
                        val node = service.findNode(selector) ?: return failFrom(results, i, op, "node not found").also { return it }
                        service.typeIntoNode(node, step["value"] as String)
                    }
                    "wait" -> {
                        Thread.sleep((step["ms"] as? Number)?.toLong() ?: 0L)
                        true
                    }
                    "assert" -> {
                        val selector = (step["selector"] as? Map<String, String?>) ?: emptyMap()
                        val expect = step["expect"] as? String ?: "present"
                        val found = service.findNode(selector) != null
                        if (expect == "present") found else !found
                    }
                    else -> false
                }
            } catch (e: Exception) {
                results.add(StepResult(i, op, false, e.message))
                return results // fail-fast: stop the whole script, do not continue past a failure
            }
            results.add(StepResult(i, op, ok))
            if (!ok) return results // fail-fast here too — an op that returned false also stops the script
        }
        return results
    }

    private fun failFrom(results: MutableList<StepResult>, i: Int, op: String, detail: String): List<StepResult> {
        results.add(StepResult(i, op, false, detail))
        return results
    }
}
```

(Clean up the slightly awkward `return failFrom(...).also { return it }` double-return in the draft above during implementation — restructure the `when` branches that need early-exit-with-detail into a small helper that throws a typed `StepFailure(detail)` exception caught by the outer `catch`, which is cleaner Kotlin than nested returns from a `when` used as an expression. Flag this as a known rough edge in the pseudocode to fix during actual implementation, not to ship as-is.)

- [ ] **Step 4: MethodChannel bridge in MainActivity**

Modify `apps/mobile/android/app/src/main/kotlin/com/dynamicsops/dynops_mobile/MainActivity.kt` (currently just `class MainActivity : FlutterActivity()` with no channel):

```kotlin
package com.dynamicsops.dynops_mobile

import android.content.Intent
import android.provider.Settings
import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import kotlin.concurrent.thread

class MainActivity : FlutterActivity() {
    private val channelName = "com.dynamicsops.dynops_mobile/operator"

    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, channelName).setMethodCallHandler { call, result ->
            when (call.method) {
                "isAccessibilityServiceEnabled" -> result.success(OperatorAccessibilityService.instance != null)
                "openAccessibilitySettings" -> {
                    startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
                    result.success(null)
                }
                "executeSteps" -> {
                    val steps = (call.arguments as? List<Map<String, Any?>>) ?: emptyList()
                    val svc = OperatorAccessibilityService.instance
                    if (svc == null) {
                        result.error("NO_SERVICE", "Accessibility service not enabled", null)
                        return@setMethodCallHandler
                    }
                    // Run off the main thread — gestures/node lookups block.
                    thread {
                        val results = OperatorStepExecutor(svc).run(steps)
                        runOnUiThread {
                            result.success(results.map { mapOf("index" to it.index, "op" to it.op, "ok" to it.ok, "detail" to it.detail) })
                        }
                    }
                }
                else -> result.notImplemented()
            }
        }
    }
}
```

- [ ] **Step 5: Dart-side channel client**

Create `apps/mobile/lib/features/operator/operator_channel.dart`:

```dart
import 'package:flutter/services.dart';

class OperatorChannel {
  static const _channel = MethodChannel('com.dynamicsops.dynops_mobile/operator');

  static Future<bool> isAccessibilityServiceEnabled() async {
    return await _channel.invokeMethod<bool>('isAccessibilityServiceEnabled') ?? false;
  }

  static Future<void> openAccessibilitySettings() async {
    await _channel.invokeMethod('openAccessibilitySettings');
  }

  static Future<List<Map<String, dynamic>>> executeSteps(List<Map<String, dynamic>> steps) async {
    final res = await _channel.invokeMethod<List<dynamic>>('executeSteps', steps);
    return (res ?? []).cast<Map<dynamic, dynamic>>().map((m) => m.cast<String, dynamic>()).toList();
  }
}
```

- [ ] **Step 6: Verify (static)**

```bash
cd apps/mobile && flutter analyze
cd apps/mobile/android && ./gradlew assembleDebug
```
Expected: `flutter analyze` clean; `assembleDebug` builds successfully (this compiles the Kotlin without needing a running emulator).

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/android/ apps/mobile/lib/features/operator/operator_channel.dart
git commit -m "feat(mobile): Kotlin AccessibilityService operator executor + MethodChannel bridge"
```

---

## Task 9: Flutter — wire execution flow end-to-end (detail screen "Execute" button, optional biometric confirm, result write-back)

**Files:**
- Modify: `apps/mobile/lib/features/operator/operator_detail_screen.dart` (replace the Task 7 placeholder button with the real flow)
- Modify: `apps/mobile/pubspec.yaml` (add `local_auth` — the one new dependency in this plan, for the optional biometric-confirm guardrail)

**Interfaces:**
- Consumes: `OperatorChannel.executeSteps` (Task 8), `OperatorActions.postResult` (Task 6), `local_auth`'s `LocalAuthentication.authenticate`.
- Produces: a complete on-device execution flow: review script → optional biometric gate (user setting, default off) → `executeSteps` → render per-step results live → `postResult`.

- [ ] **Step 1: Add `local_auth`**

```yaml
# apps/mobile/pubspec.yaml — add under dependencies:
  local_auth: ^2.3.0
```

```bash
cd apps/mobile && flutter pub get
```

- [ ] **Step 2: Implement the execute flow**

Replace the placeholder button in `operator_detail_screen.dart`:

```dart
Future<void> _execute(BuildContext context, WidgetRef ref, DeviceCommand cmd) async {
  // Optional local guardrail — additive, never a substitute for server approval
  // (the command already IS server-approved by the time it's fetchable here).
  final requireBiometric = await _readBiometricSetting(); // reads a simple local bool setting
  if (requireBiometric) {
    final auth = LocalAuthentication();
    final ok = await auth.authenticate(
      localizedReason: 'Telefon görevini çalıştırmak için doğrulayın',
      options: const AuthenticationOptions(biometricOnly: false),
    );
    if (!ok) return;
  }

  final steps = cmd.payload.cast<Map<String, dynamic>>();
  final results = await OperatorChannel.executeSteps(steps);
  final allOk = results.every((r) => r['ok'] == true);

  await ref.read(operatorActionsProvider).postResult(
        cmd.id,
        succeeded: allOk,
        steps: results,
        detail: allOk ? null : 'Failed at step ${results.lastWhere((r) => r['ok'] != true)['index']}',
      );

  ref.invalidate(operatorCommandsProvider);
  if (context.mounted) {
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(allOk ? 'Görev tamamlandı' : 'Görev başarısız — sunucuya bildirildi')),
    );
  }
}
```

Wire this into the `ElevatedButton`'s `onPressed`, and add a `ListView`/`StreamBuilder`-free simple `setState`-driven progress indicator while `executeSteps` is in flight (a spinner + "Adım X/Y çalışıyor" label is sufficient for M3 — no live per-step streaming from Kotlin in this plan, per Task 8's interface note).

- [ ] **Step 3: Verify**

```bash
cd apps/mobile && flutter analyze && flutter test
```
Expected: clean, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/lib/features/operator/operator_detail_screen.dart apps/mobile/pubspec.yaml apps/mobile/pubspec.lock
git commit -m "feat(mobile): wire operator execute flow — optional biometric confirm + result write-back"
```

---

## Final verification (whole M3)

- [ ] `pnpm --filter @dynops/api typecheck` → exit 0.
- [ ] `pnpm --filter @dynops/db push` → schema applies cleanly (device_commands table exists).
- [ ] `docker compose build api && docker compose up -d` → api boots clean.
- [ ] Full propose→approve→push→fetch→execute-report loop verified via curl+psql (Task 4, Step 7) — including the mock `(mock) silent push` log line.
- [ ] TTL guardrail verified: manually set an `approved` row's `expires_at` to the past via psql, confirm the next `GET /devices/commands?status=approved` flips it to `expired` and excludes it.
- [ ] Partial-failure guardrail verified: POST a result with one `steps[].ok: false` entry and `status: 'succeeded'` in the body — confirm the server still records `failed` (Task 4 Step 5's `allStepsOk` check wins over the client-claimed status).
- [ ] `cd apps/mobile && flutter analyze && flutter test` → clean, all tests pass.
- [ ] `cd apps/mobile/android && ./gradlew assembleDebug` → Kotlin compiles.
- [ ] **Prerequisite check (flag, do not silently skip):** confirm whether an Android device/emulator is available (`adb devices`). If not, the remaining device-dependent checks below cannot run in this environment — report this explicitly rather than claiming they passed.
- [ ] Manual device pass (requires Android device/emulator): enable the accessibility service via the onboarding screen → propose a harmless demo phone_task server-side (e.g. `open_app` Settings → `wait` → `assert` a known Settings screen element `present`) → approve it in the web Approval Center or via curl → confirm the app receives the silent push (or falls back to manual pull-to-refresh on the operator inbox) → tap into the command detail → execute → confirm Settings opens, the assert passes, and the app POSTs a `succeeded` result → confirm `device_commands.result` in psql shows per-step logs.
- [ ] Push to GitHub when the user asks (repo convention: direct-to-main, dated commits).

## Deferred / explicitly out of scope for M3

- Flutter build-flavor infrastructure (iOS-vs-Android compiled-out builds) — this plan uses runtime `Platform.isAndroid` guards only, consistent with the only precedent in this codebase (`core/push.dart`). Introducing real flavors is a separate, larger infra change not required for M3's functional scope.
- Live per-step progress streaming from the Kotlin executor back to Flutter mid-script (an `EventChannel`) — M3 ships request/response only (`executeSteps` returns once the whole script finishes or fails); a spinner suffices for the internal-only demo scope.
- Screenshot/vision-based `assert` (OCR or image diffing) — explicitly off by default per spec §3.3; this plan's `assert` is text/node-tree only via `AccessibilityNodeInfo`.
- A cron/scheduled TTL sweep — M3 uses lazy TTL checking on read (Task 4, Step 4) rather than a background job; acceptable because a stale `approved` command simply isn't returned by the next `GET`, and is never executed late in any case (the device only executes what it fetches as `approved` and not expired).
- Play Store / public App Store distribution — internal APK / ad-hoc only, for the whole app, not just the operator module.

## Risks (flagged for the user before implementation starts)

1. **AccessibilityService reliability.** Android accessibility APIs are notoriously inconsistent across OEM skins (Samsung/Xiaomi/etc. often restrict background services, add "battery optimization" kills, or delay `dispatchGesture`). `findAccessibilityNodeInfosByText`/`ByViewId` can silently return stale/empty results if `rootInActiveWindow` hasn't caught up with a screen transition — this is why every `tap`/`type`/`assert` step should carry a `timeout_ms` with retry-with-backoff in the real implementation (the pseudocode above does a single lookup attempt; harden this during Task 8 implementation, not left as-is).
2. **Google Play policy.** Apps requesting `BIND_ACCESSIBILITY_SERVICE` for non-core-accessibility purposes are routinely rejected or removed from the Play Store. This is precisely why the spec mandates internal-only distribution (APK/ad-hoc, no Play submission) — this constraint must never be relaxed without re-litigating the whole distribution model.
3. **Android SDK / emulator prerequisite.** This plan's device-dependent verification steps (Task 8 Step 0 onward, and the Final Verification manual pass) require `adb` and either a physical Android device or a configured emulator. This may not be installed in the current environment — Task 8 Step 0 explicitly checks and the plan instructs surfacing this as a blocker rather than skipping silently.
4. **Partial-script ambiguity.** A step can "succeed" at the Android API level (e.g., `performAction` returns `true`) while the actual on-screen effect didn't happen the way the plan intended (e.g., a tap lands on the wrong overlapping view during an animation). The `assert` op is the only real safety net against this — server-authored scripts should place `assert` steps liberally, and this plan's fail-fast executor (Task 8) ensures a bad assert stops the script rather than continuing blind.
5. **First platform channel in this app.** `MainActivity.kt` currently has zero platform-channel code; this plan is the first to add Kotlin business logic beyond the default Flutter template. Build/signing config quirks (Kotlin version `2.3.20`, AGP `9.0.1` per the existing `settings.gradle.kts`) should be re-checked against `local_auth`'s and any future native deps' minimum requirements before Task 9.
6. **iCloud/build-dir stall risk (environment-specific).** If this repo's working copy lives under an iCloud-synced folder, Gradle/Flutter build directories can stall or corrupt due to iCloud's on-demand file eviction. If build commands hang unexpectedly, check whether `apps/mobile/android/.gradle`/`build` dirs are iCloud-synced and consider a symlinked local build directory outside iCloud, and commit with `--no-verify` only if a pre-commit hook itself is the thing stalling on iCloud I/O (never to skip an actual failing check).

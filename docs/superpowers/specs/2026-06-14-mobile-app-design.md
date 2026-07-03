# DynOps Mobile — Design Spec

**Date:** 2026-06-14 · **Status:** approved design, pending implementation plan
**Owner:** Deniz Celan · **Repo location:** `apps/mobile` (new Flutter app in this monorepo)

## 1. Purpose & Scope

A Flutter mobile app (iOS + Android) for the DynamicsOps AI Resource Platform combining three capabilities in one product, delivered as three milestones:

1. **Companion client (M1)** — do the daily web workflows on the phone: see & decide pending approvals (single + bulk), watch activities/missions/meetings, dashboard KPIs, push notifications.
2. **Chat-first assistant (M2)** — talk to the AI team (any active resource) from the phone: text + voice input (device STT), threads, quick actions that flow through the normal draft-first approval pipeline.
3. **Autonomous phone-operator (M3, Android-only, internal build)** — the **server-side** agent plans phone tasks; the phone only **executes** approved step-scripts via an AccessibilityService engine modeled on OpenOmniBot's automation module. Every task is approval-gated in the existing Approval Center.

**Inspiration/reuse:** [OpenOmniBot](https://github.com/omnimind-ai/OpenOmniBot) (Apache-2.0, Flutter + Kotlin on-device phone-operating agent) — we reuse its Flutter chat-UI patterns and its Android accessibility/vision executor architecture (concept + code reference). We do **not** adopt its on-device agent brain: ours stays server-driven and approval-gated, consistent with the platform.

**Approach (chosen):** thin client + small platform extensions. The app is a pure client of the existing REST API (`/api/v1`, JWT Bearer + `x-workspace` header) and SSE (`/stream`); backend gains push, chat, and a device-command channel.

**Key decisions (user-approved):**
- Framework: **Flutter** (single codebase; operator via Kotlin platform channel).
- Architecture for operator: **server-driven + approval-gated** (no on-device agent brain).
- Code location: **`apps/mobile`** in this monorepo.
- Distribution: **internal** (iOS TestFlight/ad-hoc + Android APK/internal track) — avoids Play Store accessibility-policy restrictions on the operator module.
- Voice: **text + voice input** (device STT, tr-TR/en-US); TTS optional toggle. No wake-word/always-listening.

## 2. App Architecture (`apps/mobile`)

```
apps/mobile/
  lib/core/        api_client (Bearer + x-workspace), auth (flutter_secure_storage),
                   sse_client (EventSource; 8s polling fallback, same pattern as web),
                   push (firebase_messaging), router (go_router), theme
  lib/features/
    approvals/     pending list + filters (risk/resource/model/subject), detail
                   (draft text, risk, amount), approve/reject/edit-payload, multi-select bulk
    inbox/         activities list/detail (channel, status, confidence)
    missions/      mission list/detail (task graph), create mission
    meetings/      calendar approvals: accept / reject / propose-time
    chat/          resource picker, threads, voice input (speech_to_text), optional TTS (flutter_tts)
    dashboard/     KPI summary from existing /dashboard/* endpoints
    operator/      device-command inbox, execution status, permissions onboarding (Android-only)
  android/         Kotlin: AccessibilityService executor + screen detection
                   (platform channel to Flutter; inspired by OpenOmniBot automation engine)
```

- **State:** Riverpod. **Navigation:** bottom tabs — *Onaylar · Gelen Kutusu · Sohbet · Mission'lar · Daha* (dashboard/settings/operator under "Daha").
- **Theme:** mirror the web's premium DynOps design system (indigo→violet, dark/light).
- **Server URL** configurable in settings (local dev / prod).
- iOS ships companion + chat only; the operator feature module is compiled out (build flavor) — internal Android build enables it.

### Existing API surface consumed (no changes needed)
- Auth: `POST /auth/dev-login` → `{accessToken, user}` (JWT, 12h); `GET /auth/me`; roles admin/manager/consultant/viewer enforced server-side.
- Workspaces: `GET /workspaces`; scope via `x-workspace` header.
- Approvals: `GET /approvals?status=pending&…`, `GET /approvals/:id`, `POST /approvals/:id/approve|reject`, `POST /approvals/bulk`, `POST /approvals/:id/draft|regenerate`, `GET /approvals/filter-options`.
- Activities: `GET /activities?…`, `GET /activities/:id`.
- Missions: `GET /missions`, `GET /missions/:id`, `POST /missions`.
- Meetings: `GET /meetings`, `POST /meetings/:id/accept|reject|propose-time`.
- Notifications: `GET /notifications?unread=…`, `POST /notifications/:id/read`, `POST /notifications/mark-read`.
- Dashboard: `GET /dashboard/summary|agent-performance|roi|usage`.
- Realtime: `GET /stream?access_token=…&workspace=…` (SSE events: `activity`, `approval`, `notification`).

## 3. Backend Additions (services/api + worker)

All three follow existing repo patterns: fail-closed/mock-until-configured env gating, approval-gated sensitive actions, tenant scoping, audit.

### 3.1 Push notifications (FCM)
- New table `device_tokens`: `id, workspace_id, user_id, platform (ios|android), token, last_seen_at, created_at`.
- Endpoints: `POST /api/v1/devices/register` (after login), `DELETE /api/v1/devices/:token` (logout).
- `PushService` in api: FCM HTTP v1 (covers iOS via APNs). Env `FCM_SERVICE_ACCOUNT_JSON` — empty ⇒ silently disabled (same fail-closed pattern as Graph/WhatsApp).
- Triggers (added at create-paths, without touching `emitStreamEvent`): new **pending approval** ("Yeni onay: send_email — Re: X"), new **notification** row, **mission done**. Data payload `{type, id}` → notification tap deep-links to the right screen.

### 3.2 Chat endpoint
- `POST /api/v1/chat` `{resource_key, message, thread_id?}` — generalization of the Teams bot `/ask` pattern: asks the agent with the resource's model/persona, returns the reply.
- Persistence: each thread = one `channel='chat'` activity; messages in the existing `messages` table. `GET /chat/threads`, `GET /chat/threads/:id/messages`. Note: add `chat` to the `activity_channel` Prisma enum (same precedent as the existing `mission` channel) — check the enum at plan time.
- Tool intents arising from chat flow through the **normal tool_calls → approvals** pipeline (chat "şu maili gönder" ⇒ approval card).

### 3.3 Operator command channel (`device_commands`)
- New table `device_commands`: `id, workspace_id, user_id, status (proposed→awaiting_approval→approved→sent→executing→succeeded|failed|rejected|expired), kind, payload (step script: open_app/tap/type/wait/assert — adapted from OpenOmniBot's action vocabulary), result, agent_run_id, timestamps`.
- New tool in TOOL_REGISTRY: **`phone_task`** (`sensitive: true, risk: 'high', targets: 'internal'`). When the server agent proposes a phone task, the executor does **not** run it — it creates a `device_commands` row → lands in the Approval Center like every sensitive tool.
- On approval: status `approved` → silent data-push (`command_ready`) → app fetches `GET /devices/commands?status=approved` → Kotlin accessibility engine executes step-by-step → `POST /devices/commands/:id/result` (result + step logs) → audited.
- Guardrails: command TTL (default 15 min → `expired`); optional device setting "require biometric confirm before executing high-risk commands"; screenshot capture **off by default**; a partially-executed script is never silently reported as succeeded.

## 4. Security & Error Handling

- JWT in `flutter_secure_storage` (Keychain/Keystore); every request sends Bearer + `x-workspace`.
- Login: dev-login now; when `AUTH_MODE=entra`, only the login flow changes (Entra OAuth) — rest of the app unchanged.
- Roles already enforced by the API; the app trims UI by role (e.g. viewer cannot approve).
- Operator: AccessibilityService only in the internal build flavor; explicit-consent onboarding; all device actions server-audited.
- Offline: no request queue (YAGNI) — retry/backoff + "tekrar dene". SSE drop ⇒ 8s polling fallback (same as web). Push token refresh ⇒ auto re-register.
- Operator step failure ⇒ command `failed` + step log to server; agent may re-plan or a "failed" note lands in the Approval Center.

## 5. Testing & Verification

Repo pattern (no jest in api): typecheck + live curl; plus Flutter tooling.
- Backend: `pnpm --filter @dynops/api typecheck`; curl e2e — register device → create approval → observe push (mock log when FCM unset); `phone_task` → approval → command lifecycle verified via psql.
- Flutter: `flutter analyze` + `flutter test` (api client, model parsing, approval-card widget test).
- Operator live test: harmless demo script (open Settings → navigate → back) on a real device.

## 6. Milestones

| Milestone | Contents | Platforms |
|---|---|---|
| **M1 Companion** | auth, approvals (+bulk), inbox, missions, meetings, dashboard, FCM push | iOS + Android |
| **M2 Chat** | `POST /chat` + threads, voice input (STT), optional TTS | iOS + Android |
| **M3 Operator** | `phone_task` tool, `device_commands`, Kotlin accessibility engine, permissions onboarding | Android (internal build) |

Each milestone is independently shippable; M1 alone delivers ~80% of daily value.

## 7. Out of Scope (v1)

- Play Store / App Store public distribution (internal only).
- Wake-word / always-on voice.
- On-device LLM inference (OpenOmniBot's MNN/llama runtimes not adopted).
- Offline write queue; web-push.
- iOS operator (platform restrictions make it infeasible).

# DynOps Mobile — M1 Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship M1 of the DynOps Mobile app — a Flutter companion client (approvals + bulk, inbox, missions, meetings, dashboard, login) plus the backend push pipeline (device_tokens + FCM dispatcher), per the approved spec `docs/superpowers/specs/2026-06-14-mobile-app-design.md`.

**Architecture:** The app at `apps/mobile` is a thin client of the existing NestJS API (`/api/v1`, JWT Bearer + `x-workspace` header) with SSE (`/stream`) for foreground realtime and FCM push for background. Backend gains two small units following existing repo patterns: a `DevicesModule` (token registry) and a `PushDispatcherModule` (interval tick modeled on `email-watch.service.ts`, fail-closed when `FCM_SERVICE_ACCOUNT_JSON` is unset). M2 (chat) and M3 (operator) get their own plans later; this app ships a "Sohbet" placeholder tab.

**Tech Stack:** Flutter (Dart 3, Material 3), flutter_riverpod, go_router, http, flutter_secure_storage, firebase_messaging (Task 7 only). Backend: NestJS + Prisma (existing), FCM HTTP v1 with node `crypto` RS256 JWT (no new npm deps).

## Global Constraints

- Internal distribution only (TestFlight/ad-hoc + APK) — no store-review constraints.
- All API calls send `Authorization: Bearer <jwt>` + `x-workspace: <workspace-id>` headers; JWT stored in `flutter_secure_storage`.
- Server URL is user-configurable at login (default `http://localhost:4000`).
- SSE with 8-second polling fallback (same pattern as `apps/web/app/(app)/approvals/page.tsx`).
- Role-trimmed UI: `viewer` role sees no approve/reject buttons; mission creation requires `manager`/`admin`.
- Backend: new Prisma models accessed as `(this.prisma as any).device_tokens` — the repo's established pattern for late-added models (see `notifications` usage) so no client regen is needed for typecheck.
- Backend fail-closed: empty `FCM_SERVICE_ACCOUNT_JSON` ⇒ dispatcher runs in mock mode (logs `(mock) push → …`, no network).
- Backend verification: `pnpm --filter @dynops/api typecheck` must exit 0; DB schema applied by the api container boot command (`pnpm --filter @dynops/db push`); live checks via curl + `docker compose exec postgres psql`.
- Flutter verification: `flutter analyze` (no errors) + `flutter test` (all pass) inside `apps/mobile`.
- `apps/mobile` has no `package.json` → pnpm workspace globs ignore it (no monorepo config change needed).
- Do not modify `emitStreamEvent` call sites; push triggers live only in the dispatcher.
- Dev auth: `POST /api/v1/auth/dev-login {email}` → `{accessToken, user{id,email,displayName,role}}`; workspaces via `GET /api/v1/workspaces` → `[{id,name,slug,role}]`.

---

## Task 1: Backend — `device_tokens` model + Devices API

**Files:**
- Modify: `packages/db/prisma/schema.prisma` (append after the `notifications` model, ~line 836)
- Create: `services/api/src/modules/devices/devices.controller.ts`
- Modify: `services/api/src/app.module.ts` (import + register `DevicesModule`)

**Interfaces:**
- Consumes: `PrismaService` (`services/api/src/prisma/prisma.service`), `CurrentUser`/`AuthUser` (`services/api/src/auth/decorators`), `tenantStore` (`services/api/src/common/tenant`).
- Produces: table `device_tokens` (`id, workspace_id, user_id, platform, token(unique), last_seen_at, created_at`); endpoints `POST /api/v1/devices/register {platform:'ios'|'android', token}` → `{ok,id}` and `DELETE /api/v1/devices/:token` → `{ok}`. Task 2's dispatcher reads `(prisma as any).device_tokens`; Task 7's app calls these endpoints.

- [ ] **Step 1: Add the Prisma model**

Append to `packages/db/prisma/schema.prisma` (directly after the `notifications` model block):

```prisma
// Mobile push — one row per registered device token (FCM). No FK relations by
// design (same as notifications): tokens outlive membership changes and are
// pruned by the dispatcher on FCM "unregistered" responses.
model device_tokens {
  id           String   @id @default(uuid()) @db.Uuid
  workspace_id String?  @db.Uuid
  user_id      String   @db.Uuid
  platform     String   @db.VarChar(10)
  token        String   @unique @db.VarChar(512)
  last_seen_at DateTime @default(now()) @db.Timestamptz(6)
  created_at   DateTime @default(now()) @db.Timestamptz(6)

  @@index([workspace_id])
  @@index([user_id])
  @@map("device_tokens")
}
```

- [ ] **Step 2: Create the Devices controller+module (single file, repo pattern)**

Create `services/api/src/modules/devices/devices.controller.ts`:

```ts
import { Body, Controller, Delete, Module, Param, Post } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { CurrentUser, AuthUser } from '../../auth/decorators';
import { tenantStore } from '../../common/tenant';

// Mobile device registry for FCM push. Any authenticated user may register
// their own device; unregister is by exact token (called on logout).
@Controller('devices')
class DevicesController {
  constructor(private readonly prisma: PrismaService) {}

  @Post('register')
  async register(
    @Body() body: { platform: 'ios' | 'android'; token: string },
    @CurrentUser() user: AuthUser,
  ) {
    if (!body?.token || !body?.platform) return { ok: false, detail: 'platform and token required' };
    const wsId = tenantStore.getStore()?.workspaceId ?? null;
    const row = await (this.prisma as any).device_tokens.upsert({
      where: { token: body.token },
      update: { user_id: user.id, workspace_id: wsId, platform: body.platform, last_seen_at: new Date() },
      create: { token: body.token, platform: body.platform, user_id: user.id, workspace_id: wsId },
    });
    return { ok: true, id: row.id };
  }

  @Delete(':token')
  async unregister(@Param('token') token: string) {
    await (this.prisma as any).device_tokens.deleteMany({ where: { token } });
    return { ok: true };
  }
}

@Module({ controllers: [DevicesController] })
export class DevicesModule {}
```

- [ ] **Step 3: Register the module**

In `services/api/src/app.module.ts` add the import next to `MeetingsModule` and add `DevicesModule` to the `imports` array:

```ts
import { DevicesModule } from './modules/devices/devices.controller';
// … in @Module imports array, after MeetingsModule:
    DevicesModule,
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @dynops/api typecheck`
Expected: exit 0 (the `(prisma as any)` cast means no Prisma client regen is needed).

- [ ] **Step 5: Apply schema + live verify**

```bash
docker compose build api && docker compose up -d api
# wait for boot (runs `pnpm --filter @dynops/db push` then serves)
until docker compose logs api 2>&1 | tail -20 | grep -q "API listening on :4000"; do sleep 3; done
TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login -H 'content-type: application/json' -d '{"email":"admin@dynamicsops.com"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
curl -s -X POST http://localhost:4000/api/v1/devices/register -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"platform":"android","token":"test-token-1"}'
docker compose exec -T postgres psql -U dynops -d dynops -c "SELECT platform, token, user_id IS NOT NULL AS has_user FROM device_tokens;"
curl -s -X DELETE http://localhost:4000/api/v1/devices/test-token-1 -H "authorization: Bearer $TOKEN"
docker compose exec -T postgres psql -U dynops -d dynops -c "SELECT count(*) FROM device_tokens;"
```
Expected: register returns `{"ok":true,"id":"…"}`; first psql shows one `android` row; after DELETE, count is 0.

- [ ] **Step 6: Commit**

```bash
git add packages/db/prisma/schema.prisma services/api/src/modules/devices/devices.controller.ts services/api/src/app.module.ts
git commit -m "feat(api): device_tokens registry + /devices register/unregister for mobile push"
```

---

## Task 2: Backend — FCM client + PushDispatcher tick + compose env

**Files:**
- Create: `services/api/src/integrations/push/fcm.ts`
- Create: `services/api/src/integrations/push/push-dispatcher.service.ts`
- Modify: `services/api/src/app.module.ts` (register `PushDispatcherModule`)
- Modify: `docker-compose.yml` (api env: `FCM_SERVICE_ACCOUNT_JSON`, `PUSH_TICK_MS`)

**Interfaces:**
- Consumes: `(prisma as any).device_tokens` (Task 1), `prisma.approvals` / `(prisma as any).notifications` (existing).
- Produces: `fcmConfigured(): boolean`; `sendFcm(deviceToken, {title,body}, data): Promise<'ok'|'unregistered'|'error'>`; `PushDispatcherModule`. Push data payloads are `{type:'approval'|'notification', id}` — Task 7's deep-link router relies on exactly these keys.

**Design note (spec deviation, intentional):** the spec says push triggers "at create-paths", but most pending approvals are created by the **worker** (raw Prisma, separate process), so create-path hooks in the api would miss them. A watermark-scan dispatcher tick in the api (same pattern as `email-watch.service.ts` / `ado-ingestion.service.ts`) catches approvals/notifications created by *both* services with one implementation. Latency ≤ `PUSH_TICK_MS` (default 20 s) is fine for push.

- [ ] **Step 1: Create the FCM HTTP v1 client (no new deps — node crypto RS256)**

Create `services/api/src/integrations/push/fcm.ts`:

```ts
import { createSign } from 'crypto';
import { Logger } from '@nestjs/common';

// Firebase Cloud Messaging HTTP v1 client. Auth = OAuth2 service-account JWT
// (RS256 via node crypto — no googleapis dependency). FAIL-CLOSED: with no
// FCM_SERVICE_ACCOUNT_JSON, sendFcm logs a mock line and reports 'ok'.
const logger = new Logger('Fcm');

interface ServiceAccount { project_id: string; client_email: string; private_key: string }
let sa: ServiceAccount | null | undefined; // undefined = env not parsed yet
let cached: { token: string; expiresAt: number } | null = null;

export function fcmConfigured(): boolean {
  if (sa === undefined) {
    const raw = process.env.FCM_SERVICE_ACCOUNT_JSON ?? '';
    try { sa = raw ? (JSON.parse(raw) as ServiceAccount) : null; } catch { sa = null; }
  }
  return Boolean(sa?.project_id && sa?.client_email && sa?.private_key);
}

async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.expiresAt - 60 > now) return cached.token;
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const claims = Buffer.from(JSON.stringify({
    iss: sa!.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  })).toString('base64url');
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const signature = signer.sign(sa!.private_key, 'base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  });
  if (!res.ok) throw new Error(`FCM token ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  cached = { token: data.access_token, expiresAt: now + (data.expires_in ?? 3500) };
  return cached.token;
}

export async function sendFcm(
  deviceToken: string,
  notification: { title: string; body: string },
  data: Record<string, string>,
): Promise<'ok' | 'unregistered' | 'error'> {
  if (!fcmConfigured()) {
    logger.log(`(mock) push → "${notification.title}" [${data.type ?? '?'}:${data.id ?? '?'}]`);
    return 'ok';
  }
  try {
    const token = await accessToken();
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa!.project_id}/messages:send`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message: { token: deviceToken, notification, data } }),
    });
    if (res.status === 404 || res.status === 410) return 'unregistered';
    if (!res.ok) {
      logger.warn(`FCM ${res.status}: ${(await res.text()).slice(0, 200)}`);
      return 'error';
    }
    return 'ok';
  } catch (e) {
    logger.warn(`FCM send failed: ${(e as Error).message}`);
    return 'error';
  }
}
```

- [ ] **Step 2: Create the dispatcher tick service (email-watch pattern)**

Create `services/api/src/integrations/push/push-dispatcher.service.ts`:

```ts
import { Injectable, Logger, Module, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { fcmConfigured, sendFcm } from './fcm';

const PUSH_TICK_MS = Number(process.env.PUSH_TICK_MS ?? 20000);

// Watermark-scan push dispatcher: every tick, push newly created pending
// approvals and notifications to all registered devices of that workspace.
// Runs even without FCM creds (sendFcm mocks) so the pipeline is verifiable.
@Injectable()
export class PushDispatcherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('PushDispatcher');
  private timer: NodeJS.Timeout | null = null;
  private approvalsSince = new Date();
  private notificationsSince = new Date();

  constructor(private readonly prisma: PrismaService) {}

  onModuleInit() {
    if (process.env.ENABLE_PUSH === 'false') {
      this.logger.log('Push dispatcher disabled (ENABLE_PUSH=false).');
      return;
    }
    this.logger.log(`Push dispatcher active (tick ${PUSH_TICK_MS}ms, fcm=${fcmConfigured() ? 'live' : 'mock'}).`);
    this.timer = setInterval(() => this.tick().catch((e) => this.logger.warn(e.message)), PUSH_TICK_MS);
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
  }

  async tick() {
    // 1. New pending approvals since the watermark.
    const approvals = await this.prisma.approvals.findMany({
      where: { status: 'pending', created_at: { gt: this.approvalsSince } },
      include: { activity: true },
      orderBy: { created_at: 'asc' },
      take: 50,
    });
    if (approvals.length) this.approvalsSince = approvals[approvals.length - 1].created_at;
    for (const a of approvals) {
      await this.pushToWorkspace(
        a.workspace_id,
        { title: `Yeni onay: ${a.action}`, body: (a.activity?.subject ?? a.reason ?? '').slice(0, 160) },
        { type: 'approval', id: a.id },
      );
    }

    // 2. New notifications since the watermark.
    const notifs = await (this.prisma as any).notifications.findMany({
      where: { created_at: { gt: this.notificationsSince } },
      orderBy: { created_at: 'asc' },
      take: 50,
    });
    if (notifs.length) this.notificationsSince = notifs[notifs.length - 1].created_at;
    for (const n of notifs) {
      await this.pushToWorkspace(
        n.workspace_id,
        { title: String(n.title).slice(0, 100), body: String(n.message).slice(0, 160) },
        { type: 'notification', id: n.id },
      );
    }
  }

  private async pushToWorkspace(
    wsId: string | null,
    notification: { title: string; body: string },
    data: Record<string, string>,
  ) {
    const tokens = await (this.prisma as any).device_tokens.findMany({
      where: wsId ? { OR: [{ workspace_id: wsId }, { workspace_id: null }] } : {},
    });
    for (const t of tokens) {
      const result = await sendFcm(t.token, notification, data);
      if (result === 'unregistered') {
        await (this.prisma as any).device_tokens.deleteMany({ where: { token: t.token } });
        this.logger.log(`pruned unregistered device token ${String(t.token).slice(0, 12)}…`);
      }
    }
    if (tokens.length) this.logger.log(`push "${notification.title}" → ${tokens.length} device(s)`);
  }
}

@Module({ providers: [PushDispatcherService] })
export class PushDispatcherModule {}
```

- [ ] **Step 3: Register the module + compose env**

In `services/api/src/app.module.ts`:

```ts
import { PushDispatcherModule } from './integrations/push/push-dispatcher.service';
// … in imports array, after DevicesModule:
    PushDispatcherModule,
```

In `docker-compose.yml`, `api` service `environment:` block (next to the ADO vars):

```yaml
      # Mobile push (FCM HTTP v1). Empty ⇒ dispatcher runs in mock mode (logs only).
      FCM_SERVICE_ACCOUNT_JSON: ${FCM_SERVICE_ACCOUNT_JSON:-}
      PUSH_TICK_MS: ${PUSH_TICK_MS:-20000}
```

- [ ] **Step 4: Typecheck + compose validate**

Run: `pnpm --filter @dynops/api typecheck && docker compose config >/dev/null && echo OK`
Expected: exit 0, `OK`.

- [ ] **Step 5: Live verify (mock push on a fresh approval)**

```bash
docker compose build api && docker compose up -d api
until docker compose logs api 2>&1 | tail -20 | grep -q "API listening on :4000"; do sleep 3; done
docker compose logs api 2>&1 | grep "Push dispatcher active"
TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login -H 'content-type: application/json' -d '{"email":"admin@dynamicsops.com"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
# register a device, then create a notification row directly → wait one tick
curl -s -X POST http://localhost:4000/api/v1/devices/register -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"platform":"android","token":"mock-device-1"}'
docker compose exec -T postgres psql -U dynops -d dynops -c "INSERT INTO notifications (id, workspace_id, type, title, message) VALUES (gen_random_uuid(), '00000000-0000-0000-0000-0000000000ff', 'test', 'Push test', 'hello mobile');"
sleep 25 && docker compose logs api --since 40s 2>&1 | grep -E "\(mock\) push|push \""
```
Expected: `Push dispatcher active (tick 20000ms, fcm=mock)` at boot; after the insert, a `(mock) push → "Push test" [notification:…]` line and `push "Push test" → 1 device(s)`.

- [ ] **Step 6: Commit**

```bash
git add services/api/src/integrations/push/ services/api/src/app.module.ts docker-compose.yml
git commit -m "feat(api): FCM push pipeline — fcm client + watermark dispatcher tick (mock-until-configured)"
```

---

## Task 3: Flutter scaffold — core (api client, auth, storage, router, theme) + login

**Files:**
- Create: `apps/mobile/` (via `flutter create`)
- Create: `apps/mobile/lib/core/api.dart`, `apps/mobile/lib/core/session.dart`, `apps/mobile/lib/core/router.dart`, `apps/mobile/lib/core/theme.dart`
- Create: `apps/mobile/lib/features/login/login_screen.dart`
- Replace: `apps/mobile/lib/main.dart`
- Test: `apps/mobile/test/api_client_test.dart`, `apps/mobile/test/login_screen_test.dart`

**Interfaces:**
- Consumes: `POST /auth/dev-login {email}` → `{accessToken, user}`; `GET /workspaces` → `[{id,name,…}]`.
- Produces (used by every later task): `ApiClient` with `Future<dynamic> get(String path, {Map<String,String>? query})`, `post(String path, {Object? body})`, `delete(String path)`, `Uri streamUrl()`, fields `baseUrl/token/workspaceId`; Riverpod `sessionProvider` (`Session? {api, user}`), `AuthRepository.login(server,email)` / `.restore()` / `.logout()`; `appRouter` (go_router) with `/login` and shell routes; `dynopsTheme`.

- [ ] **Step 1: Verify Flutter toolchain**

Run: `flutter --version || echo MISSING`
If MISSING: install (`brew install --cask flutter`), then `flutter doctor`. Proceed once `flutter --version` prints a 3.x stable.

- [ ] **Step 2: Scaffold the app**

```bash
cd apps && flutter create --org com.dynamicsops --project-name dynops_mobile --platforms ios,android mobile && cd mobile
```

Then replace `pubspec.yaml` dependencies section:

```yaml
dependencies:
  flutter:
    sdk: flutter
  flutter_riverpod: ^2.5.1
  go_router: ^14.2.0
  http: ^1.2.1
  flutter_secure_storage: ^9.2.2
  intl: ^0.19.0

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^4.0.0
```

Run: `flutter pub get` — expected: resolves cleanly.

- [ ] **Step 3: Write the failing ApiClient test**

Create `apps/mobile/test/api_client_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:dynops_mobile/core/api.dart';

void main() {
  test('sends bearer + workspace headers and decodes json', () async {
    late http.Request seen;
    final mock = MockClient((req) async {
      seen = req;
      return http.Response('{"ok":true}', 200);
    });
    final api = ApiClient(baseUrl: 'http://x', client: mock)
      ..token = 'T'
      ..workspaceId = 'W';
    final res = await api.get('/approvals', query: {'status': 'pending'});
    expect(res['ok'], true);
    expect(seen.headers['authorization'], 'Bearer T');
    expect(seen.headers['x-workspace'], 'W');
    expect(seen.url.toString(), 'http://x/api/v1/approvals?status=pending');
  });

  test('401 throws ApiAuthException', () async {
    final api = ApiClient(baseUrl: 'http://x', client: MockClient((_) async => http.Response('', 401)));
    expect(() => api.get('/approvals'), throwsA(isA<ApiAuthException>()));
  });
}
```

- [ ] **Step 4: Run test to verify it fails**

Run: `flutter test test/api_client_test.dart`
Expected: FAIL — `core/api.dart` does not exist.

- [ ] **Step 5: Implement core files**

Create `apps/mobile/lib/core/api.dart`:

```dart
import 'dart:convert';
import 'package:http/http.dart' as http;

class ApiClient {
  ApiClient({required this.baseUrl, this.token, this.workspaceId, http.Client? client})
      : _client = client ?? http.Client();

  final String baseUrl; // e.g. http://localhost:4000
  String? token;
  String? workspaceId;
  final http.Client _client;

  Uri _u(String path, [Map<String, String>? q]) =>
      Uri.parse('$baseUrl/api/v1$path').replace(queryParameters: q);

  Map<String, String> get headers => {
        'content-type': 'application/json',
        if (token != null) 'authorization': 'Bearer $token',
        if (workspaceId != null) 'x-workspace': workspaceId!,
      };

  Future<dynamic> get(String path, {Map<String, String>? query}) async =>
      _decode(await _client.get(_u(path, query), headers: headers));

  Future<dynamic> post(String path, {Object? body}) async =>
      _decode(await _client.post(_u(path), headers: headers, body: jsonEncode(body ?? {})));

  Future<dynamic> delete(String path) async =>
      _decode(await _client.delete(_u(path), headers: headers));

  dynamic _decode(http.Response res) {
    if (res.statusCode == 401) throw ApiAuthException();
    if (res.statusCode >= 400) throw ApiException(res.statusCode, res.body);
    if (res.body.isEmpty) return null;
    return jsonDecode(res.body);
  }

  Uri streamUrl() => Uri.parse(
      '$baseUrl/api/v1/stream?access_token=${Uri.encodeComponent(token ?? '')}&workspace=${Uri.encodeComponent(workspaceId ?? '')}');
}

class ApiException implements Exception {
  ApiException(this.status, this.body);
  final int status;
  final String body;
  @override
  String toString() => 'API $status: $body';
}

class ApiAuthException implements Exception {}
```

Create `apps/mobile/lib/core/session.dart`:

```dart
import 'dart:convert';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api.dart';

class Session {
  const Session({required this.api, required this.user});
  final ApiClient api;
  final Map<String, dynamic> user;
  String get role => (user['role'] ?? 'viewer') as String;
  bool get canDecide => role != 'viewer';
  bool get canManage => role == 'manager' || role == 'admin';
}

final sessionProvider = StateProvider<Session?>((_) => null);

class AuthRepository {
  AuthRepository(this.ref);
  final Ref ref;
  static const _storage = FlutterSecureStorage();

  Future<Session> login(String serverUrl, String email) async {
    final api = ApiClient(baseUrl: serverUrl);
    final res = await api.post('/auth/dev-login', body: {'email': email});
    api.token = res['accessToken'] as String;
    final workspaces = await api.get('/workspaces') as List;
    if (workspaces.isNotEmpty) api.workspaceId = workspaces.first['id'] as String;
    final user = (res['user'] as Map).cast<String, dynamic>();
    await _storage.write(key: 'dynops_server', value: serverUrl);
    await _storage.write(key: 'dynops_token', value: api.token);
    await _storage.write(key: 'dynops_workspace', value: api.workspaceId);
    await _storage.write(key: 'dynops_user', value: jsonEncode(user));
    final session = Session(api: api, user: user);
    ref.read(sessionProvider.notifier).state = session;
    return session;
  }

  Future<Session?> restore() async {
    final server = await _storage.read(key: 'dynops_server');
    final token = await _storage.read(key: 'dynops_token');
    if (server == null || token == null) return null;
    final api = ApiClient(baseUrl: server)
      ..token = token
      ..workspaceId = await _storage.read(key: 'dynops_workspace');
    final userRaw = await _storage.read(key: 'dynops_user');
    final user = userRaw != null ? (jsonDecode(userRaw) as Map).cast<String, dynamic>() : <String, dynamic>{};
    final session = Session(api: api, user: user);
    ref.read(sessionProvider.notifier).state = session;
    return session;
  }

  Future<void> logout() async {
    await _storage.deleteAll();
    ref.read(sessionProvider.notifier).state = null;
  }
}

final authRepositoryProvider = Provider((ref) => AuthRepository(ref));
```

Create `apps/mobile/lib/core/theme.dart`:

```dart
import 'package:flutter/material.dart';

// Mirrors the web's premium DynOps system: indigo→violet accent, dark-first.
final dynopsTheme = ThemeData(
  useMaterial3: true,
  brightness: Brightness.dark,
  colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6D5DF6), brightness: Brightness.dark),
  appBarTheme: const AppBarTheme(centerTitle: false),
);
```

Create `apps/mobile/lib/core/router.dart` (shell routes filled by Tasks 4–6; start with login + a placeholder home):

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../features/login/login_screen.dart';
import 'session.dart';

GoRouter buildRouter(WidgetRef ref) => GoRouter(
      initialLocation: '/approvals',
      redirect: (context, state) {
        final loggedIn = ref.read(sessionProvider) != null;
        final onLogin = state.matchedLocation == '/login';
        if (!loggedIn && !onLogin) return '/login';
        if (loggedIn && onLogin) return '/approvals';
        return null;
      },
      routes: [
        GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
        GoRoute(
          path: '/approvals',
          builder: (_, __) => const Scaffold(body: Center(child: Text('Onaylar — Task 4'))),
        ),
      ],
    );
```

Create `apps/mobile/lib/features/login/login_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});
  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _server = TextEditingController(text: 'http://localhost:4000');
  final _email = TextEditingController(text: 'admin@dynamicsops.com');
  bool _busy = false;
  String? _error;

  Future<void> _login() async {
    setState(() { _busy = true; _error = null; });
    try {
      await ref.read(authRepositoryProvider).login(_server.text.trim(), _email.text.trim());
      if (mounted) context.go('/approvals');
    } catch (e) {
      setState(() => _error = 'Giriş başarısız: $e');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 380),
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Text('DynOps Mobile', style: Theme.of(context).textTheme.headlineMedium),
                const SizedBox(height: 24),
                TextField(controller: _server, decoration: const InputDecoration(labelText: 'Sunucu adresi')),
                const SizedBox(height: 12),
                TextField(controller: _email, decoration: const InputDecoration(labelText: 'E-posta')),
                const SizedBox(height: 24),
                FilledButton(
                  onPressed: _busy ? null : _login,
                  child: _busy ? const SizedBox(height: 18, width: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Text('Giriş'),
                ),
                if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: const TextStyle(color: Colors.redAccent))),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
```

Replace `apps/mobile/lib/main.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/router.dart';
import 'core/session.dart';
import 'core/theme.dart';

void main() => runApp(const ProviderScope(child: DynOpsApp()));

class DynOpsApp extends ConsumerStatefulWidget {
  const DynOpsApp({super.key});
  @override
  ConsumerState<DynOpsApp> createState() => _DynOpsAppState();
}

class _DynOpsAppState extends ConsumerState<DynOpsApp> {
  late final router = buildRouter(ref);
  @override
  void initState() {
    super.initState();
    ref.read(authRepositoryProvider).restore().then((_) => router.refresh());
  }

  @override
  Widget build(BuildContext context) =>
      MaterialApp.router(title: 'DynOps', theme: dynopsTheme, routerConfig: router);
}
```

- [ ] **Step 6: Write the login widget test**

Create `apps/mobile/test/login_screen_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/features/login/login_screen.dart';

void main() {
  testWidgets('login screen renders server + email fields and button', (tester) async {
    await tester.pumpWidget(const ProviderScope(child: MaterialApp(home: LoginScreen())));
    expect(find.text('Sunucu adresi'), findsOneWidget);
    expect(find.text('E-posta'), findsOneWidget);
    expect(find.text('Giriş'), findsOneWidget);
  });
}
```

- [ ] **Step 7: Run analyze + tests**

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: analyze clean (no errors), 3 tests pass.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): Flutter scaffold — api client, session/auth, router, theme, login"
```

---

## Task 4: Approvals feature (list + filters + detail + decide + bulk) + SSE client

**Files:**
- Create: `apps/mobile/lib/core/sse.dart`
- Create: `apps/mobile/lib/features/approvals/approvals_models.dart`, `approvals_repository.dart`, `approvals_screen.dart`, `approval_detail_screen.dart`
- Modify: `apps/mobile/lib/core/router.dart` (real approvals routes)
- Test: `apps/mobile/test/approvals_models_test.dart`

**Interfaces:**
- Consumes: `ApiClient`/`sessionProvider` (Task 3); API `GET /approvals?status=…`, `GET /approvals/:id`, `POST /approvals/:id/approve {note?}`, `POST /approvals/:id/reject {note}`, `POST /approvals/bulk {ids,action,note?}`.
- Produces: `Approval.fromJson` (defensive: accepts both a bare list and `{items:[…]}` list envelope), `approvalsListProvider`, `SseClient(Uri, {onEvent(String event, String data), onDown()})` — Tasks 5–6 reuse `SseClient` and the list/detail screen patterns established here.

- [ ] **Step 1: Write the failing model test**

Create `apps/mobile/test/approvals_models_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/features/approvals/approvals_models.dart';

void main() {
  test('parses approval json defensively', () {
    final a = Approval.fromJson({
      'id': 'x',
      'action': 'send_email',
      'status': 'pending',
      'risk_level': 'medium',
      'reason': 'Mission çözümü',
      'payload': {'body': 'Merhaba', 'to': ['a@b.com']},
      'created_at': '2026-06-14T10:00:00Z',
      'activity': {'subject': 'Re: Fatura', 'channel': 'email'},
    });
    expect(a.action, 'send_email');
    expect(a.subject, 'Re: Fatura');
    expect(a.draftText, 'Merhaba');
    expect(a.riskLevel, 'medium');
  });

  test('unwraps {items:[…]} envelopes', () {
    expect(unwrapList([{'id': '1'}]).length, 1);
    expect(unwrapList({'items': [{'id': '1'}, {'id': '2'}]}).length, 2);
  });
}
```

Run: `flutter test test/approvals_models_test.dart` — expected FAIL (file missing).

- [ ] **Step 2: Implement models + repository**

Create `apps/mobile/lib/features/approvals/approvals_models.dart`:

```dart
List<Map<String, dynamic>> unwrapList(dynamic body) {
  final list = body is List ? body : (body is Map ? (body['items'] as List? ?? const []) : const []);
  return list.map((e) => (e as Map).cast<String, dynamic>()).toList();
}

class Approval {
  Approval({
    required this.id,
    required this.action,
    required this.status,
    required this.riskLevel,
    this.reason,
    this.amount,
    this.subject,
    this.channel,
    this.draftText,
    this.createdAt,
  });

  final String id;
  final String action;
  final String status;
  final String riskLevel;
  final String? reason;
  final num? amount;
  final String? subject;
  final String? channel;
  final String? draftText;
  final DateTime? createdAt;

  factory Approval.fromJson(Map<String, dynamic> j) {
    final payload = (j['payload'] as Map?)?.cast<String, dynamic>() ?? const {};
    final activity = (j['activity'] as Map?)?.cast<String, dynamic>();
    String? draft;
    for (final k in ['draft_text', 'content', 'body', 'message', 'text']) {
      final v = j[k] ?? payload[k];
      if (v is String && v.isNotEmpty) { draft = v; break; }
    }
    return Approval(
      id: j['id'] as String,
      action: (j['action'] ?? '?') as String,
      status: (j['status'] ?? 'pending') as String,
      riskLevel: (j['risk_level'] ?? 'medium') as String,
      reason: j['reason'] as String?,
      amount: j['amount'] is String ? num.tryParse(j['amount'] as String) : j['amount'] as num?,
      subject: activity?['subject'] as String?,
      channel: activity?['channel'] as String?,
      draftText: draft,
      createdAt: j['created_at'] != null ? DateTime.tryParse(j['created_at'] as String) : null,
    );
  }
}
```

Create `apps/mobile/lib/features/approvals/approvals_repository.dart`:

```dart
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/session.dart';
import 'approvals_models.dart';

final approvalsListProvider = FutureProvider.autoDispose<List<Approval>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/approvals', query: {'status': 'pending'});
  return unwrapList(body).map(Approval.fromJson).toList();
});

final approvalDetailProvider = FutureProvider.autoDispose.family<Approval, String>((ref, id) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/approvals/$id');
  final map = (body is Map && body['approval'] is Map ? body['approval'] : body) as Map;
  return Approval.fromJson(map.cast<String, dynamic>());
});

class ApprovalActions {
  ApprovalActions(this.ref);
  final Ref ref;
  Future<void> approve(String id, {String? note}) async =>
      ref.read(sessionProvider)!.api.post('/approvals/$id/approve', body: {'note': note ?? ''});
  Future<void> reject(String id, {required String note}) async =>
      ref.read(sessionProvider)!.api.post('/approvals/$id/reject', body: {'note': note});
  Future<void> bulk(List<String> ids, String action) async =>
      ref.read(sessionProvider)!.api.post('/approvals/bulk', body: {'ids': ids, 'action': action});
}

final approvalActionsProvider = Provider((ref) => ApprovalActions(ref));
```

- [ ] **Step 3: Implement the SSE client**

Create `apps/mobile/lib/core/sse.dart`:

```dart
import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

/// Minimal EventSource: parses `event:`/`data:` lines from /api/v1/stream.
/// On error/close it calls [onDown] once — callers switch to 8s polling and
/// may call [connect] again to retry.
class SseClient {
  SseClient(this.url, {required this.onEvent, required this.onDown});
  final Uri url;
  final void Function(String event, String data) onEvent;
  final void Function() onDown;
  http.Client? _client;
  StreamSubscription<String>? _sub;

  Future<void> connect() async {
    close();
    _client = http.Client();
    try {
      final req = http.Request('GET', url)..headers['accept'] = 'text/event-stream';
      final res = await _client!.send(req);
      var event = 'message';
      _sub = res.stream.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
        if (line.startsWith('event:')) {
          event = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          onEvent(event, line.substring(5).trim());
        } else if (line.isEmpty) {
          event = 'message';
        }
      }, onError: (_) => onDown(), onDone: onDown, cancelOnError: true);
    } catch (_) {
      onDown();
    }
  }

  void close() {
    _sub?.cancel();
    _client?.close();
    _sub = null;
    _client = null;
  }
}
```

- [ ] **Step 4: Implement list + detail screens**

Create `apps/mobile/lib/features/approvals/approvals_screen.dart`:

```dart
import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';
import '../../core/sse.dart';
import 'approvals_models.dart';
import 'approvals_repository.dart';

const riskColors = {
  'low': Colors.teal, 'medium': Colors.amber, 'high': Colors.deepOrange, 'critical': Colors.red,
};

class ApprovalsScreen extends ConsumerStatefulWidget {
  const ApprovalsScreen({super.key});
  @override
  ConsumerState<ApprovalsScreen> createState() => _ApprovalsScreenState();
}

class _ApprovalsScreenState extends ConsumerState<ApprovalsScreen> {
  final selected = <String>{};
  SseClient? _sse;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    final api = ref.read(sessionProvider)!.api;
    _sse = SseClient(api.streamUrl(), onEvent: (event, _) {
      if (event == 'approval' || event == 'activity') ref.invalidate(approvalsListProvider);
    }, onDown: () {
      _poll ??= Timer.periodic(const Duration(seconds: 8), (_) => ref.invalidate(approvalsListProvider));
    });
    _sse!.connect();
  }

  @override
  void dispose() {
    _sse?.close();
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _bulk(String action) async {
    await ref.read(approvalActionsProvider).bulk(selected.toList(), action);
    setState(() => selected.clear());
    ref.invalidate(approvalsListProvider);
  }

  @override
  Widget build(BuildContext context) {
    final list = ref.watch(approvalsListProvider);
    final canDecide = ref.watch(sessionProvider)?.canDecide ?? false;
    return Scaffold(
      appBar: AppBar(title: const Text('Onaylar'), actions: [
        IconButton(icon: const Icon(Icons.refresh), onPressed: () => ref.invalidate(approvalsListProvider)),
      ]),
      bottomNavigationBar: selected.isEmpty || !canDecide
          ? null
          : BottomAppBar(
              child: Row(children: [
                Text('${selected.length} seçili'),
                const Spacer(),
                TextButton(onPressed: () => _bulk('reject'), child: const Text('Reddet')),
                FilledButton(onPressed: () => _bulk('approve'), child: const Text('Onayla')),
              ]),
            ),
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (items) => items.isEmpty
            ? const Center(child: Text('Bekleyen onay yok 🎉'))
            : RefreshIndicator(
                onRefresh: () async => ref.invalidate(approvalsListProvider),
                child: ListView.builder(
                  itemCount: items.length,
                  itemBuilder: (_, i) {
                    final a = items[i];
                    final sel = selected.contains(a.id);
                    return ListTile(
                      leading: canDecide
                          ? Checkbox(value: sel, onChanged: (_) => setState(() => sel ? selected.remove(a.id) : selected.add(a.id)))
                          : const Icon(Icons.pending_outlined),
                      title: Text(a.subject ?? a.reason ?? a.action, maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text(a.action),
                      trailing: Chip(
                        label: Text(a.riskLevel),
                        backgroundColor: (riskColors[a.riskLevel] ?? Colors.grey).withOpacity(0.2),
                      ),
                      onTap: () => context.push('/approvals/${a.id}'),
                    );
                  },
                ),
              ),
      ),
    );
  }
}
```

Create `apps/mobile/lib/features/approvals/approval_detail_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';
import 'approvals_repository.dart';

class ApprovalDetailScreen extends ConsumerWidget {
  const ApprovalDetailScreen({super.key, required this.id});
  final String id;

  Future<void> _decide(BuildContext context, WidgetRef ref, String action) async {
    final noteCtl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(action == 'approve' ? 'Onayla' : 'Reddet'),
        content: TextField(controller: noteCtl, decoration: const InputDecoration(labelText: 'Not (opsiyonel / red için zorunlu)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Vazgeç')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Tamam')),
        ],
      ),
    );
    if (ok != true) return;
    final actions = ref.read(approvalActionsProvider);
    if (action == 'approve') {
      await actions.approve(id, note: noteCtl.text);
    } else {
      await actions.reject(id, note: noteCtl.text.isEmpty ? 'Mobilden reddedildi' : noteCtl.text);
    }
    ref.invalidate(approvalsListProvider);
    if (context.mounted) context.pop();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(approvalDetailProvider(id));
    final canDecide = ref.watch(sessionProvider)?.canDecide ?? false;
    return Scaffold(
      appBar: AppBar(title: const Text('Onay Detayı')),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (a) => ListView(padding: const EdgeInsets.all(16), children: [
          Text(a.subject ?? a.action, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            Chip(label: Text(a.action)),
            Chip(label: Text('risk: ${a.riskLevel}')),
            if (a.amount != null) Chip(label: Text('tutar: ${a.amount}')),
          ]),
          if (a.reason != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(a.reason!)),
          const Divider(height: 32),
          Text('Taslak', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Card(child: Padding(padding: const EdgeInsets.all(12), child: SelectableText(a.draftText ?? '(taslak metni yok)'))),
          const SizedBox(height: 24),
          if (canDecide)
            Row(children: [
              Expanded(child: OutlinedButton(onPressed: () => _decide(context, ref, 'reject'), child: const Text('Reddet'))),
              const SizedBox(width: 12),
              Expanded(child: FilledButton(onPressed: () => _decide(context, ref, 'approve'), child: const Text('Onayla'))),
            ]),
        ]),
      ),
    );
  }
}
```

- [ ] **Step 5: Wire routes**

In `apps/mobile/lib/core/router.dart`, replace the placeholder `/approvals` route with:

```dart
        GoRoute(path: '/approvals', builder: (_, __) => const ApprovalsScreen()),
        GoRoute(path: '/approvals/:id', builder: (_, s) => ApprovalDetailScreen(id: s.pathParameters['id']!)),
```

and add the imports:

```dart
import '../features/approvals/approvals_screen.dart';
import '../features/approvals/approval_detail_screen.dart';
```

- [ ] **Step 6: Run analyze + tests, then manual smoke**

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: clean, all tests pass (2 new model tests included).

Manual smoke (stack running): `flutter run` on a simulator; log in against `http://localhost:4000` (Android emulator: use `http://10.0.2.2:4000`); confirm the pending-approvals list loads real data, tapping opens the detail, approve moves an item out of the list.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): approvals list/detail with approve/reject/bulk + SSE live refresh"
```

---

## Task 5: Tab shell + Inbox + Dashboard

**Files:**
- Create: `apps/mobile/lib/shell.dart`
- Create: `apps/mobile/lib/features/inbox/inbox_screen.dart`, `apps/mobile/lib/features/inbox/activity_detail_screen.dart`
- Create: `apps/mobile/lib/features/dashboard/dashboard_screen.dart`
- Modify: `apps/mobile/lib/core/router.dart` (StatefulShellRoute with 5 tabs)
- Test: `apps/mobile/test/shell_test.dart`

**Interfaces:**
- Consumes: `ApiClient`, `sessionProvider`, `unwrapList` (Task 4); API `GET /activities?status=…&page=&pageSize=`, `GET /activities/:id`, `GET /dashboard/summary`.
- Produces: `AppShell` with `NavigationBar` tabs *Onaylar · Gelen Kutusu · Sohbet · Missionlar · Daha*; routes `/inbox`, `/inbox/:id`, `/chat` (placeholder "M2'de geliyor"), `/missions` (placeholder until Task 6), `/more` (dashboard + logout). Task 6 replaces the missions placeholder.

- [ ] **Step 1: Write the failing shell test**

Create `apps/mobile/test/shell_test.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/shell.dart';

void main() {
  testWidgets('shell renders 5 tabs', (tester) async {
    await tester.pumpWidget(MaterialApp(home: AppShell(child: const SizedBox(), currentPath: '/approvals', onTab: (_) {})));
    for (final label in ['Onaylar', 'Gelen Kutusu', 'Sohbet', 'Missionlar', 'Daha']) {
      expect(find.text(label), findsOneWidget);
    }
  });
}
```

Run: `flutter test test/shell_test.dart` — expected FAIL.

- [ ] **Step 2: Implement the shell**

Create `apps/mobile/lib/shell.dart`:

```dart
import 'package:flutter/material.dart';

const _tabs = [
  (path: '/approvals', icon: Icons.fact_check_outlined, label: 'Onaylar'),
  (path: '/inbox', icon: Icons.inbox_outlined, label: 'Gelen Kutusu'),
  (path: '/chat', icon: Icons.chat_bubble_outline, label: 'Sohbet'),
  (path: '/missions', icon: Icons.rocket_launch_outlined, label: 'Missionlar'),
  (path: '/more', icon: Icons.grid_view_outlined, label: 'Daha'),
];

class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.child, required this.currentPath, required this.onTab});
  final Widget child;
  final String currentPath;
  final void Function(String path) onTab;

  @override
  Widget build(BuildContext context) {
    final index = _tabs.indexWhere((t) => currentPath.startsWith(t.path)).clamp(0, _tabs.length - 1);
    return Scaffold(
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (i) => onTab(_tabs[i].path),
        destinations: [for (final t in _tabs) NavigationDestination(icon: Icon(t.icon), label: t.label)],
      ),
    );
  }
}
```

- [ ] **Step 3: Implement inbox + dashboard screens**

Create `apps/mobile/lib/features/inbox/inbox_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';
import '../approvals/approvals_models.dart';

final _statusFilter = StateProvider<String?>((_) => null);

final activitiesProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  final status = ref.watch(_statusFilter);
  final body = await api.get('/activities', query: {
    'pageSize': '50',
    if (status != null) 'status': status,
  });
  return unwrapList(body);
});

const _statuses = ['new', 'watching', 'in_progress', 'awaiting_approval', 'completed', 'escalated'];

class InboxScreen extends ConsumerWidget {
  const InboxScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(activitiesProvider);
    final selected = ref.watch(_statusFilter);
    return Scaffold(
      appBar: AppBar(title: const Text('Gelen Kutusu')),
      body: Column(children: [
        SizedBox(
          height: 48,
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
            for (final s in _statuses)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: FilterChip(
                  label: Text(s),
                  selected: selected == s,
                  onSelected: (_) => ref.read(_statusFilter.notifier).state = selected == s ? null : s,
                ),
              ),
          ]),
        ),
        Expanded(
          child: list.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Text('Hata: $e')),
            data: (items) => RefreshIndicator(
              onRefresh: () async => ref.invalidate(activitiesProvider),
              child: ListView.builder(
                itemCount: items.length,
                itemBuilder: (_, i) {
                  final a = items[i];
                  return ListTile(
                    leading: CircleAvatar(child: Text((a['channel'] ?? '?').toString().substring(0, 1).toUpperCase())),
                    title: Text((a['subject'] ?? '(konu yok)').toString(), maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text('${a['channel']} · ${a['status']}'),
                    onTap: () => context.push('/inbox/${a['id']}'),
                  );
                },
              ),
            ),
          ),
        ),
      ]),
    );
  }
}
```

Create `apps/mobile/lib/features/inbox/activity_detail_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/session.dart';

final _activityDetail = FutureProvider.autoDispose.family<Map<String, dynamic>, String>((ref, id) async {
  final api = ref.watch(sessionProvider)!.api;
  return ((await api.get('/activities/$id')) as Map).cast<String, dynamic>();
});

class ActivityDetailScreen extends ConsumerWidget {
  const ActivityDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(_activityDetail(id));
    return Scaffold(
      appBar: AppBar(title: const Text('Aktivite')),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (a) => ListView(padding: const EdgeInsets.all(16), children: [
          Text((a['subject'] ?? '(konu yok)').toString(), style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            Chip(label: Text('${a['channel']}')),
            Chip(label: Text('${a['status']}')),
            if (a['priority'] != null) Chip(label: Text('${a['priority']}')),
          ]),
          const Divider(height: 32),
          SelectableText((a['body'] ?? '').toString()),
        ]),
      ),
    );
  }
}
```

Create `apps/mobile/lib/features/dashboard/dashboard_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';

final _summary = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  return ((await api.get('/dashboard/summary')) as Map).cast<String, dynamic>();
});

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final summary = ref.watch(_summary);
    final session = ref.watch(sessionProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Daha'), actions: [
        IconButton(
          icon: const Icon(Icons.logout),
          onPressed: () async {
            await ref.read(authRepositoryProvider).logout();
            if (context.mounted) context.go('/login');
          },
        ),
      ]),
      body: summary.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (s) => GridView.count(
          padding: const EdgeInsets.all(16),
          crossAxisCount: 2,
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
          childAspectRatio: 1.4,
          children: [
            _kpi('İşlenen Aktivite', '${s['activitiesHandled'] ?? '—'}'),
            _kpi('Bekleyen Onay', '${s['pendingApprovals'] ?? '—'}'),
            _kpi('Eskalasyon', '${s['escalations'] ?? '—'}'),
            _kpi('Agent Çalıştırma', '${s['agentRuns'] ?? '—'}'),
            _kpi('Ort. Güven', s['avgConfidence'] != null ? '%${((s['avgConfidence'] as num) * 100).round()}' : '—'),
            _kpi('Kazanılan Süre', '${s['timeSavedMins'] ?? '—'} dk'),
            _kpi('Kullanıcı', session?.user['displayName']?.toString() ?? '—'),
          ],
        ),
      ),
    );
  }

  Widget _kpi(String label, String value) => Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
            Text(value, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text(label, style: const TextStyle(fontSize: 12, color: Colors.white70)),
          ]),
        ),
      );
}
```

- [ ] **Step 4: Rewire the router with the shell**

Replace the `routes:` list in `apps/mobile/lib/core/router.dart` with a `ShellRoute` so tabs share the bottom bar:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../features/approvals/approvals_screen.dart';
import '../features/approvals/approval_detail_screen.dart';
import '../features/inbox/inbox_screen.dart';
import '../features/inbox/activity_detail_screen.dart';
import '../features/dashboard/dashboard_screen.dart';
import '../features/login/login_screen.dart';
import '../shell.dart';
import 'session.dart';

GoRouter buildRouter(WidgetRef ref) => GoRouter(
      initialLocation: '/approvals',
      redirect: (context, state) {
        final loggedIn = ref.read(sessionProvider) != null;
        final onLogin = state.matchedLocation == '/login';
        if (!loggedIn && !onLogin) return '/login';
        if (loggedIn && onLogin) return '/approvals';
        return null;
      },
      routes: [
        GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
        ShellRoute(
          builder: (context, state, child) => AppShell(
            currentPath: state.matchedLocation,
            onTab: (path) => GoRouter.of(context).go(path),
            child: child,
          ),
          routes: [
            GoRoute(path: '/approvals', builder: (_, __) => const ApprovalsScreen()),
            GoRoute(path: '/approvals/:id', builder: (_, s) => ApprovalDetailScreen(id: s.pathParameters['id']!)),
            GoRoute(path: '/inbox', builder: (_, __) => const InboxScreen()),
            GoRoute(path: '/inbox/:id', builder: (_, s) => ActivityDetailScreen(id: s.pathParameters['id']!)),
            GoRoute(path: '/chat', builder: (_, __) => const Scaffold(body: Center(child: Text('Sohbet — M2\'de geliyor')))),
            GoRoute(path: '/missions', builder: (_, __) => const Scaffold(body: Center(child: Text('Missionlar — Task 6')))),
            GoRoute(path: '/more', builder: (_, __) => const DashboardScreen()),
          ],
        ),
      ],
    );
```

- [ ] **Step 5: Analyze + tests**

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: clean; shell test passes.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): tab shell + inbox (filters/detail) + dashboard KPIs + logout"
```

---

## Task 6: Missions + Meetings

**Files:**
- Create: `apps/mobile/lib/features/missions/missions_screen.dart`, `mission_detail_screen.dart`
- Create: `apps/mobile/lib/features/meetings/meetings_screen.dart`
- Modify: `apps/mobile/lib/core/router.dart` (replace missions placeholder; add `/missions/:id`, `/meetings`)
- Modify: `apps/mobile/lib/features/dashboard/dashboard_screen.dart` (add a "Toplantılar" entry point)
- Test: `apps/mobile/test/meetings_models_test.dart`

**Interfaces:**
- Consumes: `ApiClient`, `sessionProvider`, `unwrapList` (Task 4); API `GET /missions` → `[{id,title,goal,status,lead_resource,_count:{tasks}}]`, `GET /missions/:id` → `{mission,tasks,messages}`, `POST /missions {goal}` (manager+), `GET /meetings`, `POST /meetings/:id/accept`, `POST /meetings/:id/reject {note?}`, `POST /meetings/:id/propose-time {newTime,note?}`.
- Produces: routes `/missions`, `/missions/:id`, `/meetings`; `Meeting.fromJson`.

- [ ] **Step 1: Write the failing meetings model test**

Create `apps/mobile/test/meetings_models_test.dart`:

```dart
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/features/meetings/meetings_screen.dart';

void main() {
  test('parses meeting approval json', () {
    final m = Meeting.fromJson({
      'id': 'a1',
      'action': 'create_calendar_event',
      'meeting': {'title': 'Demo', 'start': '2026-06-15T09:00:00Z', 'end': '2026-06-15T10:00:00Z', 'attendees': ['x@y.com'], 'location': 'Teams'},
    });
    expect(m.title, 'Demo');
    expect(m.start!.hour, 9);
    expect(m.attendees, ['x@y.com']);
  });
}
```

Run: `flutter test test/meetings_models_test.dart` — expected FAIL.

- [ ] **Step 2: Implement missions screens**

Create `apps/mobile/lib/features/missions/missions_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';
import '../approvals/approvals_models.dart';

final missionsProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  return unwrapList(await api.get('/missions'));
});

const missionStatusColors = {
  'planning': Colors.blueGrey, 'running': Colors.blue, 'done': Colors.teal, 'blocked': Colors.deepOrange,
};

class MissionsScreen extends ConsumerWidget {
  const MissionsScreen({super.key});

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final goalCtl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Yeni Mission'),
        content: TextField(controller: goalCtl, maxLines: 3, decoration: const InputDecoration(labelText: 'Hedef (goal)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Vazgeç')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Başlat')),
        ],
      ),
    );
    if (ok != true || goalCtl.text.trim().isEmpty) return;
    await ref.read(sessionProvider)!.api.post('/missions', body: {'goal': goalCtl.text.trim()});
    ref.invalidate(missionsProvider);
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(missionsProvider);
    final canManage = ref.watch(sessionProvider)?.canManage ?? false;
    return Scaffold(
      appBar: AppBar(title: const Text('Missionlar')),
      floatingActionButton: canManage
          ? FloatingActionButton(onPressed: () => _create(context, ref), child: const Icon(Icons.add))
          : null,
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (items) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(missionsProvider),
          child: ListView.builder(
            itemCount: items.length,
            itemBuilder: (_, i) {
              final m = items[i];
              final status = (m['status'] ?? '?').toString();
              return ListTile(
                leading: Icon(Icons.rocket_launch, color: missionStatusColors[status] ?? Colors.grey),
                title: Text((m['title'] ?? m['goal'] ?? '?').toString(), maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text('$status · ${(m['_count']?['tasks'] ?? 0)} görev'),
                onTap: () => context.push('/missions/${m['id']}'),
              );
            },
          ),
        ),
      ),
    );
  }
}
```

Create `apps/mobile/lib/features/missions/mission_detail_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/session.dart';
import 'missions_screen.dart';

final _missionDetail = FutureProvider.autoDispose.family<Map<String, dynamic>, String>((ref, id) async {
  final api = ref.watch(sessionProvider)!.api;
  return ((await api.get('/missions/$id')) as Map).cast<String, dynamic>();
});

class MissionDetailScreen extends ConsumerWidget {
  const MissionDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(_missionDetail(id));
    return Scaffold(
      appBar: AppBar(title: const Text('Mission')),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (d) {
          final mission = ((d['mission'] ?? d) as Map).cast<String, dynamic>();
          final tasks = (d['tasks'] as List? ?? const []).cast<Map>();
          final status = (mission['status'] ?? '?').toString();
          return ListView(padding: const EdgeInsets.all(16), children: [
            Text((mission['title'] ?? '?').toString(), style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Chip(label: Text(status), backgroundColor: (missionStatusColors[status] ?? Colors.grey).withOpacity(0.2)),
            const SizedBox(height: 8),
            Text((mission['goal'] ?? '').toString()),
            const Divider(height: 32),
            Text('Görevler (${tasks.length})', style: Theme.of(context).textTheme.titleMedium),
            for (final t in tasks)
              ListTile(
                dense: true,
                leading: Icon(
                  t['status'] == 'done' ? Icons.check_circle : (t['status'] == 'in_progress' ? Icons.timelapse : Icons.circle_outlined),
                  color: t['status'] == 'done' ? Colors.teal : Colors.grey,
                ),
                title: Text((t['title'] ?? '?').toString(), maxLines: 2),
                subtitle: Text((t['status'] ?? '').toString()),
              ),
          ]);
        },
      ),
    );
  }
}
```

- [ ] **Step 3: Implement meetings screen (model + list + actions in one file)**

Create `apps/mobile/lib/features/meetings/meetings_screen.dart`:

```dart
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:intl/intl.dart';
import '../../core/session.dart';
import '../approvals/approvals_models.dart';

class Meeting {
  Meeting({required this.id, this.title, this.start, this.end, this.attendees = const [], this.location});
  final String id;
  final String? title;
  final DateTime? start;
  final DateTime? end;
  final List<String> attendees;
  final String? location;

  factory Meeting.fromJson(Map<String, dynamic> j) {
    final m = (j['meeting'] as Map?)?.cast<String, dynamic>() ?? const {};
    return Meeting(
      id: j['id'] as String,
      title: (m['title'] ?? j['reason'] ?? 'Toplantı') as String?,
      start: m['start'] != null ? DateTime.tryParse(m['start'] as String)?.toLocal() : null,
      end: m['end'] != null ? DateTime.tryParse(m['end'] as String)?.toLocal() : null,
      attendees: (m['attendees'] as List? ?? const []).map((e) => e.toString()).toList(),
      location: m['location'] as String?,
    );
  }
}

final meetingsProvider = FutureProvider.autoDispose<List<Meeting>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  return unwrapList(await api.get('/meetings')).map(Meeting.fromJson).toList();
});

class MeetingsScreen extends ConsumerWidget {
  const MeetingsScreen({super.key});

  Future<void> _act(WidgetRef ref, String id, String action, {Map<String, dynamic>? body}) async {
    await ref.read(sessionProvider)!.api.post('/meetings/$id/$action', body: body);
    ref.invalidate(meetingsProvider);
  }

  Future<void> _proposeTime(BuildContext context, WidgetRef ref, Meeting m) async {
    final date = await showDatePicker(
      context: context,
      initialDate: m.start ?? DateTime.now(),
      firstDate: DateTime.now(),
      lastDate: DateTime.now().add(const Duration(days: 90)),
    );
    if (date == null || !context.mounted) return;
    final time = await showTimePicker(context: context, initialTime: const TimeOfDay(hour: 10, minute: 0));
    if (time == null) return;
    final newTime = DateTime(date.year, date.month, date.day, time.hour, time.minute).toUtc().toIso8601String();
    await _act(ref, m.id, 'propose-time', body: {'newTime': newTime});
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(meetingsProvider);
    final canDecide = ref.watch(sessionProvider)?.canDecide ?? false;
    final fmt = DateFormat('d MMM HH:mm');
    return Scaffold(
      appBar: AppBar(title: const Text('Toplantılar')),
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (items) => items.isEmpty
            ? const Center(child: Text('Bekleyen toplantı onayı yok'))
            : ListView.builder(
                itemCount: items.length,
                itemBuilder: (_, i) {
                  final m = items[i];
                  return Card(
                    margin: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
                    child: Padding(
                      padding: const EdgeInsets.all(12),
                      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                        Text(m.title ?? 'Toplantı', style: Theme.of(context).textTheme.titleMedium),
                        const SizedBox(height: 4),
                        Text([
                          if (m.start != null) fmt.format(m.start!),
                          if (m.location != null) m.location!,
                          if (m.attendees.isNotEmpty) m.attendees.join(', '),
                        ].join(' · ')),
                        if (canDecide)
                          Row(mainAxisAlignment: MainAxisAlignment.end, children: [
                            TextButton(onPressed: () => _act(ref, m.id, 'reject', body: {'note': 'Mobilden reddedildi'}), child: const Text('Reddet')),
                            TextButton(onPressed: () => _proposeTime(context, ref, m), child: const Text('Alternatif zaman')),
                            FilledButton(onPressed: () => _act(ref, m.id, 'accept'), child: const Text('Kabul')),
                          ]),
                      ]),
                    ),
                  );
                },
              ),
      ),
    );
  }
}
```

- [ ] **Step 4: Wire routes + dashboard entry**

In `apps/mobile/lib/core/router.dart`: replace the `/missions` placeholder with real routes and add `/meetings`:

```dart
import '../features/missions/missions_screen.dart';
import '../features/missions/mission_detail_screen.dart';
import '../features/meetings/meetings_screen.dart';
// …
            GoRoute(path: '/missions', builder: (_, __) => const MissionsScreen()),
            GoRoute(path: '/missions/:id', builder: (_, s) => MissionDetailScreen(id: s.pathParameters['id']!)),
            GoRoute(path: '/meetings', builder: (_, __) => const MeetingsScreen()),
```

In `apps/mobile/lib/features/dashboard/dashboard_screen.dart`, add a meetings tile as the first grid child (navigates via go_router):

```dart
            GestureDetector(onTap: () => context.push('/meetings'), child: _kpi('Toplantılar', '→')),
```

- [ ] **Step 5: Analyze + tests + manual smoke**

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: clean, meetings model test passes. Manual: missions list shows live missions (e.g. the Topic Missions from ADO), detail shows the task graph states.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): missions list/detail + create, meetings accept/reject/propose-time"
```

---

## Task 7: FCM in the app — token registration + notification deep links

**Files:**
- Modify: `apps/mobile/pubspec.yaml` (add `firebase_core`, `firebase_messaging`)
- Create: `apps/mobile/lib/core/push.dart`
- Modify: `apps/mobile/lib/main.dart` (init push after session restore/login)
- Modify: `apps/mobile/lib/core/session.dart` (call device register/unregister)
- Create: `apps/mobile/README.md` (Firebase setup + run instructions)

**Interfaces:**
- Consumes: `POST /devices/register {platform,token}` and `DELETE /devices/:token` (Task 1); push data payload `{type:'approval'|'notification', id}` (Task 2).
- Produces: `initPush(Session, GoRouter)` — safe no-op when Firebase isn't configured (dev simulators keep working without google-services files).

- [ ] **Step 1: Add dependencies**

In `apps/mobile/pubspec.yaml` add to `dependencies:`:

```yaml
  firebase_core: ^3.3.0
  firebase_messaging: ^15.0.4
```

Run: `flutter pub get` — expected: resolves.

- [ ] **Step 2: Implement guarded push init**

Create `apps/mobile/lib/core/push.dart`:

```dart
import 'dart:io' show Platform;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:go_router/go_router.dart';
import 'session.dart';

/// Registers this device for FCM push and wires notification-tap deep links.
/// Safe no-op when Firebase isn't configured for the build (no
/// google-services.json / GoogleService-Info.plist) — dev builds keep working.
Future<void> initPush(Session session, GoRouter router) async {
  try {
    await Firebase.initializeApp();
  } catch (_) {
    return; // Firebase not configured for this build — skip push.
  }
  try {
    final messaging = FirebaseMessaging.instance;
    await messaging.requestPermission();
    final token = await messaging.getToken();
    if (token != null) {
      await session.api.post('/devices/register', body: {
        'platform': Platform.isIOS ? 'ios' : 'android',
        'token': token,
      });
    }
    messaging.onTokenRefresh.listen((t) {
      session.api.post('/devices/register', body: {
        'platform': Platform.isIOS ? 'ios' : 'android',
        'token': t,
      });
    });

    void route(RemoteMessage m) {
      final type = m.data['type'];
      final id = m.data['id'];
      if (id == null) return;
      if (type == 'approval') router.push('/approvals/$id');
      if (type == 'notification') router.go('/inbox');
    }

    FirebaseMessaging.onMessageOpenedApp.listen(route);
    final initial = await messaging.getInitialMessage();
    if (initial != null) route(initial);
  } catch (_) {
    // Push is best-effort: never break app start.
  }
}
```

- [ ] **Step 3: Wire into app start + logout**

In `apps/mobile/lib/main.dart`, after session restore succeeds, call push init:

```dart
import 'core/push.dart';
// … in _DynOpsAppState.initState():
    ref.read(authRepositoryProvider).restore().then((session) {
      router.refresh();
      if (session != null) initPush(session, router);
    });
```

In `apps/mobile/lib/features/login/login_screen.dart` `_login()`, after successful login:

```dart
      final session = await ref.read(authRepositoryProvider).login(_server.text.trim(), _email.text.trim());
      if (mounted) {
        initPush(session, GoRouter.of(context));
        context.go('/approvals');
      }
```

(add `import '../../core/push.dart';` and `import 'package:go_router/go_router.dart';` — the latter already imported)

In `apps/mobile/lib/core/session.dart` `logout()`, before clearing storage, best-effort unregister:

```dart
  Future<void> logout() async {
    try {
      final s = ref.read(sessionProvider);
      final token = await _storage.read(key: 'dynops_push_token');
      if (s != null && token != null) await s.api.delete('/devices/$token');
    } catch (_) {/* best-effort */}
    await _storage.deleteAll();
    ref.read(sessionProvider.notifier).state = null;
  }
```

and in `push.dart`, after `getToken()` succeeds, persist it:

```dart
      await const FlutterSecureStorage().write(key: 'dynops_push_token', value: token);
```

(add `import 'package:flutter_secure_storage/flutter_secure_storage.dart';` to `push.dart`)

- [ ] **Step 4: Write the README (Firebase + run instructions)**

Create `apps/mobile/README.md`:

```markdown
# DynOps Mobile (M1 Companion)

Flutter client for the DynamicsOps AI Resource Platform.

## Run (dev, no Firebase needed)
1. Start the platform: `docker compose up -d` (repo root) — API at http://localhost:4000.
2. `cd apps/mobile && flutter run` (iOS simulator: server `http://localhost:4000`; Android emulator: `http://10.0.2.2:4000`).
3. Login: `admin@dynamicsops.com` (dev mode).

Push is a safe no-op until Firebase is configured.

## Enable push (internal builds)
1. Create a Firebase project (e.g. `dynops-mobile`), add Android app `com.dynamicsops.dynops_mobile` and iOS app.
2. `dart pub global activate flutterfire_cli && flutterfire configure` — drops `google-services.json` / `GoogleService-Info.plist`.
3. Backend: set `FCM_SERVICE_ACCOUNT_JSON` in `.env` (Firebase → Project settings → Service accounts → generate key; paste the JSON as one line), then `docker compose up -d api`.
4. iOS: enable Push Notifications capability + upload the APNs key to Firebase (internal/TestFlight distribution).
```

- [ ] **Step 5: Analyze + tests + backend e2e**

Run: `cd apps/mobile && flutter analyze && flutter test`
Expected: clean (Firebase code compiles without config; tests unaffected).

Backend loop check (mock FCM): run the app on a simulator, log in (this registers no FCM token without Firebase — verify instead via curl):

```bash
TOKEN=$(curl -s -X POST http://localhost:4000/api/v1/auth/dev-login -H 'content-type: application/json' -d '{"email":"admin@dynamicsops.com"}' | sed -n 's/.*"accessToken":"\([^"]*\)".*/\1/p')
curl -s -X POST http://localhost:4000/api/v1/devices/register -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"platform":"android","token":"e2e-device"}'
docker compose exec -T postgres psql -U dynops -d dynops -c "INSERT INTO notifications (id, type, title, message, workspace_id) VALUES (gen_random_uuid(), 'test', 'M1 e2e', 'push loop check', '00000000-0000-0000-0000-0000000000ff');"
sleep 25 && docker compose logs api --since 40s 2>&1 | grep "M1 e2e"
```
Expected: `(mock) push → "M1 e2e" [notification:…]`.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile
git commit -m "feat(mobile): FCM push — guarded init, device register/unregister, notification deep links"
```

---

## Final verification (whole M1)

- [ ] `pnpm --filter @dynops/api typecheck` → exit 0.
- [ ] `docker compose build api && docker compose up -d` → api boots, logs show `Push dispatcher active`.
- [ ] `cd apps/mobile && flutter analyze && flutter test` → clean, all tests pass.
- [ ] Manual device pass: login → approvals list (live data) → approve one (it executes / leaves list) → bulk select 2 → inbox filter chips → mission detail shows task states → meetings accept → dashboard KPIs → logout/login.
- [ ] Push loop (mock): insert a notification row via psql → within 20 s the api log shows `(mock) push` (full FCM path needs the Firebase/`FCM_SERVICE_ACCOUNT_JSON` setup from `apps/mobile/README.md`).
- [ ] Push to GitHub when the user asks (repo convention: direct-to-main, dated commits).

## Deferred to their own plans
- **M2 Chat:** `POST /api/v1/chat` + threads (`channel='chat'` enum addition) + voice input (speech_to_text) + TTS toggle — replaces the Sohbet placeholder tab.
- **M3 Operator:** `phone_task` tool + `device_commands` lifecycle + Kotlin AccessibilityService engine + permissions onboarding (Android internal flavor).

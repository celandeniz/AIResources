# AGENTS.md — DynamicsOps AI Resource Platform

Guidance for coding agents (Codex) working in this monorepo. Read this fully before starting.

## Repo shape
- pnpm + Turborepo monorepo. `apps/web` (Next.js 15), `apps/mobile` (Flutter — the mobile app), `services/api` (NestJS + Prisma/Postgres), `services/worker` (BullMQ), `services/agent` (FastAPI/LangGraph), `packages/shared` (TS types incl. TOOL_REGISTRY), `packages/db` (Prisma schema).
- Backend runs via `docker compose up -d` (postgres 5434, redis 6380, api 4000, web 3001, agent 8000, worker). API applies schema on boot via `pnpm --filter @dynops/db push` (schema-push, NOT migrations — there is no migrations/ dir).

## Conventions (do not violate)
- Work **directly on `main`**, dated commits, no PRs. **Commit with `git commit --no-verify --no-gpg-sign`** (see iCloud note). If a commit hangs >60s, check `git log --oneline -1` before retrying — it often already committed (avoid double commits).
- **Draft-first / approval-gated**: every sensitive/outward/monetary tool (send_email, devops_*, bc_*, code_task, phone_task, send_whatsapp) MUST route through the Approval Center (tool_calls → approvals). Never bypass it.
- **Multi-tenant**: all API calls carry `Authorization: Bearer <jwt>` + `x-workspace: <id>`; tenant scoping via `tenantStore`. New late-added Prisma models are accessed as `(this.prisma as any).model` to avoid client regen; a **typed enum change** (e.g. adding a value to `activity_channel`) DOES need `pnpm --filter @dynops/db build` (runs `prisma generate`) before api typecheck.
- Fail-closed / mock-until-configured for all external integrations (empty creds ⇒ mock, never crash).

## ⚠️ CRITICAL ENVIRONMENT GOTCHAS (this machine)
- **Flutter** is at `~/development/flutter` and is NOT on PATH. Every shell block that runs flutter/dart must start with:
  `export PATH="$HOME/development/flutter/bin:$PATH"`
- **CocoaPods** (for iOS builds) is at `~/homebrew/Library/Homebrew/vendor/portable-ruby/4.0.5_1/bin` (system Ruby is too old). For iOS builds prepend:
  `export PATH="$HOME/homebrew/Library/Homebrew/vendor/portable-ruby/4.0.5_1/bin:$HOME/development/flutter/bin:$PATH"`
- **iCloud stall**: the repo lives under `~/Documents` (iCloud). This intermittently hangs `git`/`tsc` and BREAKS the iOS Flutter-framework copy ("Failed to copy Flutter framework"). Mitigation already in place: **`apps/mobile/build` is a symlink to `/tmp/dynops_mobile_build` — keep it.** If it's missing, recreate: `rm -rf apps/mobile/build && mkdir -p /tmp/dynops_mobile_build && ln -s /tmp/dynops_mobile_build apps/mobile/build`.
- **Flutter SPM is disabled** (`flutter config --no-enable-swift-package-manager`) — iOS uses CocoaPods. Keep it disabled (Firebase SPM resolution fails on this machine).
- **iOS Simulator** (already installed): iPhone 17 Pro, id `F851E60E-1BA4-4FAC-B130-C3483B90A414`, iOS 26.5 runtime. Boot with `xcrun simctl boot <id>; open -a Simulator`. Screenshot with `xcrun simctl io <id> screenshot /tmp/x.png`.
- **Android SDK/emulator may NOT be installed** — M3 (operator) needs it; check `flutter doctor` / `adb` and surface (don't silently skip) if missing.

## Verification (per task)
- Backend: `pnpm --filter @dynops/api typecheck` (exit 0). If tsc hangs (iCloud), substitute `docker compose build api 2>&1 | tail -5` (its `nest build` type-checks the same code). Live checks: curl against http://localhost:4000/api/v1 (dev login: `POST /auth/dev-login {"email":"admin@dynamicsops.com"}` → `accessToken`; send it as Bearer + `x-workspace: 00000000-0000-0000-0000-0000000000ff`) and `docker compose exec -T postgres psql -U dynops -d dynops -c "..."`.
- Mobile: `export PATH="$HOME/development/flutter/bin:$PATH"; cd apps/mobile; flutter analyze` (no issues) + `flutter test` (all green — there are 12 passing tests; never regress them). iOS smoke: rebuild on the simulator id above (iOS build needs the CocoaPods PATH prepend + the /tmp build symlink).

## Current work — mobile roadmap plans (execute in THIS order)
Three implementation plans are ready in `docs/superpowers/plans/`. Execute them task-by-task, committing each task:
1. **`2026-07-04-mobile-design-uplift.md`** (PRIORITY — do first): bring the Flutter app to visual parity with the web premium design system (tokens/typography/component library/charts/motion/white-label). 8 tasks.
2. **`2026-07-04-mobile-m2-chat.md`**: chat-first assistant (`POST /api/v1/chat` + threads + STT/TTS). 7 tasks.
3. **`2026-07-04-mobile-m3-operator.md`**: server-driven, approval-gated phone operator (phone_task → device_commands → Kotlin AccessibilityService, Android-only). 9 tasks.

Each plan has a Global Constraints section and per-task Files/Interfaces/Steps with exact code and a verification step. The design spec is `docs/superpowers/specs/2026-06-14-mobile-app-design.md`. M1 (already shipped) is `docs/superpowers/plans/2026-06-14-mobile-m1-companion.md` — the format reference and the current app baseline.

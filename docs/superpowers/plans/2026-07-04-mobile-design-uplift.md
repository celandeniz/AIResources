# DynOps Mobile — Premium Design-System Uplift Implementation Plan

> **For the implementing agent (Codex):** Execute task-by-task. Each task is independently testable (`flutter analyze` clean + `flutter test` green). Steps use `- [ ]`. This plan brings the Flutter app (`apps/mobile`) to visual parity with the web app's premium design system.

**Goal:** Replace the mobile app's Material-3-default look with a bespoke design system that mirrors the web app's tokens, typography, component library, and signature patterns (ConfidenceDial, KPI cards, status/risk color system, skeletons, empty states, micro-animations, white-label branding) — so mobile feels as polished and intentional as the web.

**Architecture:** A `lib/ui/` design layer: `ui/tokens/` (colors, typography, radii, shadows, motion — the single source of truth, mirroring `apps/web/app/globals.css` + `tailwind.config.ts`), `ui/components/` (reusable widgets mirroring `apps/web/components/ui/*` + `domain.tsx`), and a `ui/charts/` layer (fl_chart). Existing feature screens are refactored to consume these. Light + dark themes + per-workspace accent override (white-label) match the web.

**Tech Stack:** Flutter (Dart 3, Material 3 as the substrate, heavily themed), `google_fonts` (Fraunces display serif) + bundled Geist Sans/Mono TTF assets, `fl_chart` (sparklines + donut), `flutter_animate` (optional, for entrance/micro-animations — or hand-rolled AnimationControllers). No backend changes.

## Global Constraints (exact values — copy verbatim from the web system)

**Color tokens (HSL — build with `HSLColor.fromAHSL(1, h, s/100, l/100).toColor()`):**

Dark theme (primary target; the app is dark-first):
- background `233 22% 7.5%` · foreground `233 18% 92%` · card `233 19% 10.5%` · cardForeground `233 18% 92%`
- muted `233 15% 16%` · mutedForeground `233 12% 62%` · accent `252 40% 20%` · accentForeground `252 80% 86%`
- primary `<brandH> <brandS> 68%` (default brandH=252, brandS=83%) · primaryForeground `233 40% 8%`
- success `152 52% 46%` · warning `36 94% 56%` · danger `0 74% 62%` · border `233 14% 19%` · input `233 14% 21%` · ring = primary
- shadowColor `233 60% 2%`

Light theme (implement for the toggle):
- background `40 33% 98.5%` · foreground `233 27% 11%` · card `0 0% 100%` · muted `240 22% 95.5%` · mutedForeground `233 11% 44%`
- accent `252 70% 96%` · accentForeground `252 60% 36%` · primary `<brandH> <brandS> 60%` · primaryForeground `0 0% 100%`
- success `152 56% 38%` · warning `33 92% 48%` · danger `0 72% 55%` · border `240 20% 89%` · shadowColor `233 40% 30%`

**White-label:** primary lightness is theme-driven (dark 68% / light 60%); only hue (`brandH`) + saturation (`brandS`) come from `workspace.branding.accent_hue`/`accent_sat`. Read the workspace branding from the session (the `GET /workspaces` / session user already carries workspace; if branding isn't in the session payload, default to 252/83 and note it).

**Radii:** base `13.6` (rounded-lg/xl for cards), md `9.6` (buttons, inputs), sm `5.6` (chips, dropdown items), full (pills, avatars).

**Shadows (BoxShadow, color = shadowColor at listed opacity):** xs `0 1 2 /0.04`; sm `0 1 3 /0.06` + `0 1 2 -1 /0.05`; md `0 4 12 -2 /0.08` + `0 2 6 -2 /0.05`; lg `0 12 32 -8 /0.14` + `0 4 12 -4 /0.06`; glow `0 0 0 1 primary/0.18` + `0 8 28 -6 primary/0.28`.

**Motion curves (Cubic):** easeOut `Cubic(0.23,1,0.32,1)`; easeInOut `Cubic(0.77,0,0.175,1)`; easeDrawer `Cubic(0.32,0.72,0,1)`. Standard durations: 150ms (buttons/hover), 240ms (page fade-up), 600ms (ConfidenceDial arc), 1600ms (shimmer loop).

**Typography:** display = **Fraunces** (serif, weights 400/500/600) via google_fonts, used for page titles + KPI values (`tracking-tight`, tabular figures where numeric); body/UI = **Geist Sans** (bundle TTFs, OFL); numeric/mono = **Geist Mono** (tabular nums for tables/data). Section titles = Geist Sans 11px, weight 600, UPPERCASE, letterSpacing 0.14em. KPI value = Fraunces ~30px. Enable tabular figures (`FontFeature.tabularFigures()`) on all numeric displays (the web's `.tnum`).

**Status → variant mapping (mirror `domain.tsx:11-27`):** new/watching/archived → neutral(grey); triaging/routed/in_progress → default(primary); awaiting_approval/pending → warning(amber); escalated/failed/rejected → danger(red); completed/approved/succeeded → success(teal). Each StatusBadge shows a 6px colored dot + label on a soft (12-15% opacity) tinted pill.

**Risk → color (Confidence/risk):** low→success, medium→warning, high→deepOrange/danger-ish, critical→danger. ConfidenceDial thresholds: `<0.5` danger, `0.5–0.72` warning, `≥0.72` success.

**Toolchain notes:** Flutter is at `~/development/flutter` (NOT on PATH — `export PATH="$HOME/development/flutter/bin:$PATH"`). CocoaPods for iOS at `~/homebrew/Library/Homebrew/vendor/portable-ruby/4.0.5_1/bin` (add to PATH for iOS builds). The repo lives under iCloud (`~/Documents`) which stalls git/tsc and breaks the iOS Flutter-framework copy — **`apps/mobile/build` is symlinked to `/tmp/dynops_mobile_build`; keep it that way**. Commit with `git commit --no-verify --no-gpg-sign` (retry once if it hangs >60s; check `git log` first). Verify each task with `flutter analyze` (clean) + `flutter test` (all green). iOS simulator id for smoke checks: `F851E60E-1BA4-4FAC-B130-C3483B90A414` (iPhone 17 Pro). Never regress the existing 12 passing tests.

---

## Task 1: Design tokens — colors, radii, shadows, motion + white-label

**Files:** Create `apps/mobile/lib/ui/tokens/colors.dart`, `radii.dart`, `shadows.dart`, `motion.dart`, `tokens.dart` (barrel). Test: `apps/mobile/test/ui/tokens_test.dart`.

**Interfaces (binding for all later tasks):**
- `class DynColors { final Color bg, fg, card, cardFg, muted, mutedFg, accent, accentFg, primary, primaryFg, success, warning, danger, border, input, ring, shadow; ... }`
- `DynColors darkColors({double brandH = 252, double brandS = 83})` and `lightColors({...})` — build every token from the exact HSL values above via `HSLColor.fromAHSL`.
- `class DynRadii { static const card = 13.6, md = 9.6, sm = 5.6; }` (+ `BorderRadius` helpers).
- `class DynShadows { static List<BoxShadow> xs/sm/md/lg(DynColors c); static List<BoxShadow> glow(DynColors c); }`.
- `class DynMotion { static const easeOut = Cubic(0.23,1,0.32,1); static const easeInOut = Cubic(0.77,0,0.175,1); static const easeDrawer = Cubic(0.32,0.72,0,1); static const dBtn = Duration(milliseconds:150); static const dPage = Duration(milliseconds:240); static const dDial = Duration(milliseconds:600); static const dShimmer = Duration(milliseconds:1600); }`

**Steps:**
- [ ] Write a test asserting `darkColors().primary` equals the HSL `252 83% 68%` conversion and `darkColors(brandH: 200).primary` shifts hue (white-label works); assert `lightColors().bg` differs from dark. RED.
- [ ] Implement the token classes with the exact HSL values from Global Constraints. GREEN.
- [ ] `flutter analyze && flutter test`.
- [ ] Commit `feat(mobile): design tokens (colors/radii/shadows/motion) + white-label accent`.

## Task 2: Typography + ThemeData (light + dark) + branding provider

**Files:** Add fonts to `apps/mobile/pubspec.yaml` (bundle Geist Sans + Geist Mono TTFs under `apps/mobile/assets/fonts/`; download the OFL Geist fonts). Create `apps/mobile/lib/ui/tokens/typography.dart`, rewrite `apps/mobile/lib/core/theme.dart`, create `apps/mobile/lib/core/branding.dart` (Riverpod providers for `themeModeProvider` + `brandingProvider`). Test: `apps/mobile/test/ui/theme_test.dart`.

**Interfaces:**
- `class DynType { static TextStyle pageTitle/kpi/cardTitle/sectionTitle/body/bodyMuted/mono(DynColors c); }` — Fraunces for pageTitle/kpi, Geist Sans for the rest, Geist Mono for `mono`, tabular figures on kpi/mono, letterSpacing 0.14em uppercase on sectionTitle.
- `ThemeData buildTheme({required Brightness brightness, double brandH, double brandS})` — full Material 3 ThemeData whose ColorScheme, cardTheme, chipTheme, inputDecorationTheme, textTheme, navigationBarTheme all derive from `DynColors`/`DynType`. AppBar transparent, centerTitle false.
- `final themeModeProvider = StateProvider<ThemeMode>((_) => ThemeMode.dark);`
- `final brandingProvider = StateProvider<({double h, double s})>((_) => (h: 252, s: 83));` — set from session workspace branding on login/restore.

**Steps:**
- [ ] Download Geist Sans (Regular/Medium/SemiBold) + Geist Mono TTFs into `assets/fonts/`; declare in pubspec `fonts:`. Add `google_fonts` + `fl_chart` deps.
- [ ] Write a test: `buildTheme(brightness: dark).colorScheme.primary` matches `darkColors().primary`; `DynType.kpi(...)` uses tabular figures. RED → implement → GREEN.
- [ ] Wire `main.dart` `MaterialApp.router` to use `buildTheme` for `theme`/`darkTheme` and `themeModeProvider`; on login/restore set `brandingProvider` from the session's workspace branding (default 252/83 if absent). Keep existing router/session behavior.
- [ ] `flutter analyze && flutter test` (existing 12 tests stay green). Commit `feat(mobile): Fraunces/Geist typography + light+dark ThemeData + branding provider`.

## Task 3: Core components I — DynCard, DynButton, DynBadge, StatusBadge, ChannelChip

**Files:** Create `apps/mobile/lib/ui/components/{dyn_card,dyn_button,dyn_badge,status_badge,channel_chip}.dart` + barrel `apps/mobile/lib/ui/components/components.dart`. Test: `apps/mobile/test/ui/components_test.dart`.

**Interfaces (mirror the web variants exactly):**
- `DynCard({child, padding = 20, glow = false})` → rounded 13.6, 1px border, card bg, shadow xs (glow → shadow glow).
- `DynButton({variant: default|secondary|outline|ghost|danger|success, size: sm|md|lg|icon, onPressed, child})` → rounded 9.6 (lg → 13.6), 150ms transitions, press scale 0.98 (wrap child in an `AnimatedScale`/`GestureDetector`), colors per variant (default = primary bg + glow-on-press; outline = border + card bg; ghost = transparent + muted hover; danger/success accents).
- `DynBadge({variant: default|neutral|success|warning|danger|outline, child, leadingDot: bool})` → pill (rounded full), soft tinted bg (`variantColor.withOpacity(0.12–0.15)`), variant-colored text, optional 6px dot.
- `StatusBadge(String status)` → maps status→variant per Global Constraints, renders `DynBadge(variant, leadingDot: true, child: Text(label))`.
- `ChannelChip(String channel)` → rounded 5.6, muted/40 bg, border, 12px channel icon (map email→mail, teams→groups, calendar→event, devops→bug/task, github→code, whatsapp→chat, mission→rocket, manual→edit) + label.

**Steps:**
- [ ] Widget test: render `StatusBadge('awaiting_approval')` → finds warning styling + dot; `DynButton(variant: outline)` → has border; `ChannelChip('email')` → shows a mail icon. RED.
- [ ] Implement the five widgets against the token layer. GREEN.
- [ ] `flutter analyze && flutter test`. Commit `feat(mobile/ui): DynCard/DynButton/DynBadge + StatusBadge + ChannelChip`.

## Task 4: ConfidenceDial (signature component)

**Files:** Create `apps/mobile/lib/ui/components/confidence_dial.dart`. Test: `apps/mobile/test/ui/confidence_dial_test.dart`.

**Interface:** `ConfidenceDial({required double value /*0..1*/, double size = 64})` — a `CustomPaint` radial gauge: background arc (muted, strokeWidth 4), value arc (threshold color: `<0.5` danger / `0.5–0.72` warning / `≥0.72` success, strokeWidth 4, round cap, sweep = value·2π from top), center = `{percent}%` in Geist Mono semibold (tabular) + tiny uppercase "conf" label. Animate the sweep from 0→value over 600ms `DynMotion.easeOut` on first build (AnimationController + Tween).

**Steps:**
- [ ] Test: `ConfidenceDial(value: 0.9)` builds and shows "90%"; the painter picks success color for 0.9, danger for 0.3 (expose the color-picker as a pure `static Color colorFor(double v, DynColors c)` and test that). RED → implement → GREEN.
- [ ] `flutter analyze && flutter test`. Commit `feat(mobile/ui): animated ConfidenceDial radial gauge`.

## Task 5: KpiCard + sparkline + DonutChart (fl_chart)

**Files:** Create `apps/mobile/lib/ui/charts/{kpi_card,sparkline,donut_chart}.dart`. Test: `apps/mobile/test/ui/charts_test.dart`.

**Interfaces:**
- `KpiCard({required String label, required String value, String? sub, double? deltaPct, List<double>? spark, DynAccent accent = primary})` → `DynCard` with: uppercase tracked label + optional delta chip (▲/▼ + %); Fraunces 30px tabular value; optional sub; optional 40px `Sparkline` (fl_chart LineChart, filled gradient in accent color).
- `Sparkline(List<double> data, Color color)` → minimal filled area line, no axes/labels.
- `DonutChart({required List<({String name, double value, Color color})> data, String centerLabel})` → fl_chart PieChart innerRadius 42/outer 62, center total label (Fraunces), right-side legend with 10px color swatches + mono values (mirror `charts.tsx` DonutChart).

**Steps:**
- [ ] Test: `KpiCard(label:'Onaylar', value:'185')` renders label + value; `DonutChart` with 2 slices renders center label. RED → implement → GREEN.
- [ ] `flutter analyze && flutter test`. Commit `feat(mobile/ui): KpiCard + sparkline + donut chart (fl_chart)`.

## Task 6: EmptyState, PageHeader, SectionTitle, Skeleton (shimmer)

**Files:** Create `apps/mobile/lib/ui/components/{empty_state,page_header,section_title,skeleton}.dart`. Test: `apps/mobile/test/ui/scaffolding_test.dart`.

**Interfaces:**
- `EmptyState({required IconData icon, required String title, String? hint, Widget? action})` → dashed 1px border, rounded 13.6, tall padding (64), centered muted icon-in-box + title + hint + optional action button.
- `PageHeader({required String title, String? subtitle, List<Widget> actions = const []})` → Fraunces 24px title (tracking-tight) + muted subtitle + right-aligned action row; bottom margin 24.
- `SectionTitle(String text, {Widget? trailing})` → Geist 11px 600 uppercase letterSpacing 0.14em muted + optional trailing.
- `Skeleton({double? width, double? height, BorderRadius? radius})` → muted/70 box with a left→right shimmer gradient sweep animating over 1600ms infinitely (AnimationController + ShaderMask or AnimatedBuilder).

**Steps:**
- [ ] Widget test: `EmptyState(...)` shows title + icon; `SectionTitle('X')` shows uppercased text; `Skeleton()` builds and animates (pump a frame). RED → implement → GREEN.
- [ ] `flutter analyze && flutter test`. Commit `feat(mobile/ui): EmptyState/PageHeader/SectionTitle/Skeleton`.

## Task 7: Apply the system to feature screens

**Files (modify):** `apps/mobile/lib/features/approvals/{approvals_screen,approval_detail_screen}.dart`, `features/inbox/{inbox_screen,activity_detail_screen}.dart`, `features/dashboard/dashboard_screen.dart`, `features/missions/{missions_screen,mission_detail_screen}.dart`, `features/meetings/meetings_screen.dart`. Keep ALL existing providers/logic/tests working — this is a visual refactor only.

**Steps (each its own commit + `flutter analyze && flutter test` green):**
- [ ] **Approvals list:** replace ListTile rows with `DynCard` rows: subject (body), `StatusBadge`(status) + `DynBadge`(risk) + small `ConfidenceDial` when the approval carries a confidence value; bulk bar uses `DynButton`s; empty → `EmptyState(icon: check_circle, title: 'Bekleyen onay yok')`.
- [ ] **Approval detail:** add the **explainability panel** — a `DynCard` with the `ConfidenceDial` (large), reasoning text (`reason`), and, when present in the payload, token cost + any citations; draft in a `DynCard` with mono where appropriate; decide buttons = `DynButton(success/danger)`.
- [ ] **Inbox:** rows become `DynCard` with `ChannelChip`(channel) + `StatusBadge`(status) + subject; filter chips restyled via chipTheme; empty → `EmptyState`. Detail uses `PageHeader` + `ChannelChip`.
- [ ] **Dashboard:** `PageHeader('Komuta merkezi')`; KPI grid of `KpiCard`s (Onaylar/İşlenen/Eskalasyon/Agent/Güven/Süre) with sparklines where a series is cheap, `ConfidenceDial` or a `KpiCard` for avg confidence; a `DonutChart` for AI-vs-human if the dashboard endpoint provides it; show `Skeleton` KPI cards while loading. Keep the logout + Toplantılar entry.
- [ ] **Missions + Meetings:** `DynCard` rows, `StatusBadge` for mission status, `PageHeader`s, `EmptyState`s, `DynButton`s for actions.

## Task 8: App-shell polish + motion + theme toggle + white-label wiring

**Files:** `apps/mobile/lib/shell.dart` (NavigationBar restyle + a top app bar area with actions), `apps/mobile/lib/core/router.dart` (fade-up page transitions), `apps/mobile/lib/features/dashboard/dashboard_screen.dart` (add a theme toggle + notifications entry in the "Daha" screen or the shell app bar). Test: keep suite green.

**Steps:**
- [ ] Restyle the bottom `NavigationBar` via `navigationBarTheme` (indicator = primary/12, selected label primary). Add a slim top area / per-screen `PageHeader`s so the app has the web's titled-page feel (mobile-appropriate — no sidebar; bottom nav is the correct adaptation of the web sidebar).
- [ ] Add a **theme toggle** (dark/light) and a **notifications** affordance (badge count from `GET /notifications?unread=true`) into the "Daha" screen or shell app bar, driving `themeModeProvider`.
- [ ] Add **fade-up page transitions** (240ms `easeOut`) via a custom `CustomTransitionPage` in go_router; add press-scale to `DynButton` (done in Task 3) and the dial/skeleton animations (done). Wire `brandingProvider` so the whole primary system recolors per workspace accent.
- [ ] `flutter analyze && flutter test`; iOS simulator smoke: rebuild and screenshot approvals + dashboard to confirm the premium look. Commit `feat(mobile): premium app-shell polish + motion + theme toggle + white-label`.

---

## Verification checklist (whole uplift)
- [ ] `export PATH="$HOME/development/flutter/bin:$PATH"; cd apps/mobile; flutter analyze` → no issues.
- [ ] `flutter test` → all green (original 12 + new UI tests).
- [ ] iOS build + screenshot (build dir symlinked to /tmp): approvals list shows DynCards + StatusBadge + ConfidenceDial; dashboard shows KpiCards + donut + skeletons on load; dark/light toggle works; changing `brandingProvider` hue recolors the app.
- [ ] No feature logic/regressions — every original screen still loads live data and every original test passes.
- [ ] Fonts render (Fraunces titles/KPIs, Geist body/mono) — bundled assets, no missing-font boxes.

## Notes for the implementer
- The web is the reference; match spacing/density (cards padding 20, gaps ~10-12, page padding 16-24). Prefer restraint + precision over decoration — the premium feel is layered shadows, refined type, tabular numbers, threshold color coding, and snappy easing, not heavy ornamentation.
- Mobile adaptation of the web sidebar = the existing bottom nav; do not port a desktop sidebar. Bring the *quality* (tokens, components, motion), not the desktop layout.
- Charts: `fl_chart` is the chosen lib (pure Dart, no native deps → safe for iOS).

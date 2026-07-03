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

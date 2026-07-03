import 'dart:io' show Platform;
import 'package:firebase_core/firebase_core.dart';
import 'package:firebase_messaging/firebase_messaging.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
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
      await const FlutterSecureStorage().write(key: 'dynops_push_token', value: token);
    }
    messaging.onTokenRefresh.listen((t) async {
      try {
        await const FlutterSecureStorage().write(key: 'dynops_push_token', value: t);
        await session.api.post('/devices/register', body: {
          'platform': Platform.isIOS ? 'ios' : 'android',
          'token': t,
        });
      } catch (_) {/* best-effort */}
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

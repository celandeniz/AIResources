import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/push.dart';
import 'core/router.dart';
import 'core/session.dart';
import 'core/theme.dart';
import 'core/branding.dart';

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
    ref.read(authRepositoryProvider).restore().then((session) {
      router.refresh();
      if (session != null) initPush(session, router);
    });
  }

  @override
  Widget build(BuildContext context) {
    final branding = ref.watch(brandingProvider);
    return MaterialApp.router(
      title: 'DynOps',
      theme: buildTheme(brightness: Brightness.light, brandH: branding.h, brandS: branding.s),
      darkTheme: buildTheme(brightness: Brightness.dark, brandH: branding.h, brandS: branding.s),
      themeMode: ref.watch(themeModeProvider),
      routerConfig: router,
    );
  }
}

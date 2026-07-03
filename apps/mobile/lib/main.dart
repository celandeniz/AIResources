import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/push.dart';
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
    ref.read(authRepositoryProvider).restore().then((session) {
      router.refresh();
      if (session != null) initPush(session, router);
    });
  }

  @override
  Widget build(BuildContext context) =>
      MaterialApp.router(title: 'DynOps', theme: dynopsTheme, routerConfig: router);
}

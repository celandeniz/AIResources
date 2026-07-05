import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'core/push.dart';
import 'core/router.dart';
import 'core/session.dart';
import 'core/theme.dart';
import 'core/branding.dart';
import 'features/operator/operator_repository.dart';

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
    onCommandPush = (_) => ref.invalidate(operatorCommandsProvider);
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
      // Turkish-first product: pin the locale so voice input (STT), TTS, and
      // date/time formatting all resolve to Turkish regardless of the device
      // language. speech_to_text/flutter_tts read Localizations.localeOf(context).
      locale: const Locale('tr'),
      supportedLocales: const [Locale('tr'), Locale('en')],
      localizationsDelegates: const [
        GlobalMaterialLocalizations.delegate,
        GlobalWidgetsLocalizations.delegate,
        GlobalCupertinoLocalizations.delegate,
      ],
      routerConfig: router,
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'api.dart';
import 'session.dart';

/// Shared error state for API-backed screens. On auth expiry it offers a
/// direct path back to login instead of a dead "Hata: …" wall.
class ApiErrorView extends ConsumerWidget {
  const ApiErrorView({super.key, required this.error, this.onRetry});
  final Object error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    if (error is ApiAuthException) {
      return Center(
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          const Text('Oturum süresi doldu'),
          const SizedBox(height: 12),
          FilledButton(
            onPressed: () async {
              await ref.read(authRepositoryProvider).logout();
              if (context.mounted) context.go('/login');
            },
            child: const Text('Tekrar giriş yap'),
          ),
        ]),
      );
    }
    return Center(
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Text('Hata: $error'),
        if (onRetry != null) TextButton(onPressed: onRetry, child: const Text('Tekrar dene')),
      ]),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api_error_view.dart';
import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';
import '../../ui/tokens/tokens.dart';
import 'operator_onboarding_screen.dart';
import 'operator_repository.dart';

class OperatorScreen extends ConsumerStatefulWidget {
  const OperatorScreen({super.key});

  @override
  ConsumerState<OperatorScreen> createState() => _OperatorScreenState();
}

class _OperatorScreenState extends ConsumerState<OperatorScreen> {
  bool? _consented;

  @override
  void initState() {
    super.initState();
    hasOperatorConsent().then((value) {
      if (mounted) setState(() => _consented = value);
    });
  }

  @override
  Widget build(BuildContext context) {
    if (_consented == null) {
      return const Scaffold(body: Center(child: CircularProgressIndicator()));
    }
    if (_consented == false) {
      return OperatorOnboardingScreen(onConsented: () => setState(() => _consented = true));
    }

    final commands = ref.watch(operatorCommandsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Telefon Görevleri')),
      body: commands.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => ApiErrorView(
          error: error,
          onRetry: () => ref.invalidate(operatorCommandsProvider),
        ),
        data: (list) {
          if (list.isEmpty) {
            return const Padding(
              padding: EdgeInsets.all(16),
              child: EmptyState(
                icon: Icons.phone_android,
                title: 'Onaylanmış görev yok',
                hint: 'Telefon görevleri Approval Center onayından sonra burada görünür.',
              ),
            );
          }
          return RefreshIndicator(
            onRefresh: () => ref.refresh(operatorCommandsProvider.future),
            child: ListView.separated(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 28),
              itemCount: list.length,
              separatorBuilder: (_, __) => const SizedBox(height: 10),
              itemBuilder: (context, index) {
                final command = list[index];
                return DynCard(
                  padding: 16,
                  onTap: () => context.push('/operator/commands/${command.id}'),
                  child: Row(
                    children: [
                      const Icon(Icons.smart_toy_outlined),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(command.kind, style: DynType.cardTitle(dynColorsFor(context))),
                            const SizedBox(height: 4),
                            Text('${command.payload.length} adım · ${command.status}',
                                style: DynType.bodyMuted(dynColorsFor(context))),
                          ],
                        ),
                      ),
                      const Icon(Icons.chevron_right),
                    ],
                  ),
                );
              },
            ),
          );
        },
      ),
    );
  }
}

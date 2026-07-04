import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';
import '../../ui/tokens/tokens.dart';
import 'operator_repository.dart';

class OperatorDetailScreen extends ConsumerWidget {
  const OperatorDetailScreen({super.key, required this.commandId});
  final String commandId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final commands = ref.watch(operatorCommandsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Görev Detayı')),
      body: commands.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(child: Text('Hata: $error')),
        data: (list) {
          final matches = list.where((c) => c.id == commandId);
          if (matches.isEmpty) {
            return const Padding(
              padding: EdgeInsets.all(16),
              child: EmptyState(
                icon: Icons.hourglass_empty,
                title: 'Görev bulunamadı',
                hint: 'Görev süresi dolmuş veya sonuç bildirilmiş olabilir.',
              ),
            );
          }
          final command = matches.first;
          final c = dynColorsFor(context);
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
            children: [
              PageHeader(title: command.kind, subtitle: '${command.payload.length} adım'),
              const SizedBox(height: 12),
              DynCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Sunucu tarafından planlanan adımlar', style: DynType.cardTitle(c)),
                    const SizedBox(height: 12),
                    for (final indexed in command.payload.indexed)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        dense: true,
                        leading: CircleAvatar(
                          radius: 14,
                          child: Text('${indexed.$1 + 1}'),
                        ),
                        title: Text(indexed.$2.toString()),
                      ),
                    const SizedBox(height: 18),
                    const DynButton(
                      onPressed: null,
                      child: Text('Çalıştır'),
                    ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }
}

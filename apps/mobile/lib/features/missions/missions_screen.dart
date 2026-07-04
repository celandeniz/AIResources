import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api_error_view.dart';
import '../../core/session.dart';
import '../../ui/components/components.dart';
import '../approvals/approvals_models.dart';

final missionsProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>(
  (ref) async {
    final api = ref.watch(sessionProvider)!.api;
    return unwrapList(await api.get('/missions'));
  },
);

const missionStatusColors = {
  'planning': Colors.blueGrey,
  'running': Colors.blue,
  'done': Colors.teal,
  'blocked': Colors.deepOrange,
};

class MissionsScreen extends ConsumerWidget {
  const MissionsScreen({super.key});

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final goalCtl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Yeni Mission'),
        content: TextField(
          controller: goalCtl,
          maxLines: 3,
          decoration: const InputDecoration(labelText: 'Hedef (goal)'),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Vazgeç'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Başlat'),
          ),
        ],
      ),
    );
    if (ok != true || goalCtl.text.trim().isEmpty) return;
    try {
      await ref
          .read(sessionProvider)!
          .api
          .post('/missions', body: {'goal': goalCtl.text.trim()});
      ref.invalidate(missionsProvider);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('Mission başlatılamadı: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(missionsProvider);
    final canManage = ref.watch(sessionProvider)?.canManage ?? false;
    return Scaffold(
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ApiErrorView(
          error: e,
          onRetry: () => ref.invalidate(missionsProvider),
        ),
        data: (items) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(missionsProvider),
          child: SafeArea(
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
              children: [
                PageHeader(
                  title: 'Missionlar',
                  subtitle: 'Çok adımlı operasyon planları',
                  actions: [
                    if (canManage)
                      DynButton(
                        size: DynButtonSize.icon,
                        onPressed: () => _create(context, ref),
                        child: const Icon(Icons.add),
                      ),
                  ],
                ),
                if (items.isEmpty)
                  const EmptyState(
                    icon: Icons.rocket_launch_outlined,
                    title: 'Aktif mission yok',
                  )
                else
                  for (final m in items) ...[
                    DynCard(
                      padding: 16,
                      onTap: () => context.push('/missions/${m['id']}'),
                      child: Row(
                        children: [
                          const Icon(Icons.rocket_launch_outlined),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  (m['title'] ?? m['goal'] ?? '?').toString(),
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                const SizedBox(height: 8),
                                Wrap(
                                  spacing: 8,
                                  runSpacing: 8,
                                  children: [
                                    StatusBadge(
                                      (m['status'] ?? 'planning').toString(),
                                    ),
                                    DynBadge(
                                      variant: DynBadgeVariant.neutral,
                                      child: Text(
                                        '${(m['_count']?['tasks'] ?? 0)} görev',
                                      ),
                                    ),
                                  ],
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

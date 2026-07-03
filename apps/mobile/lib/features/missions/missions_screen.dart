import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';
import '../approvals/approvals_models.dart';

final missionsProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  return unwrapList(await api.get('/missions'));
});

const missionStatusColors = {
  'planning': Colors.blueGrey, 'running': Colors.blue, 'done': Colors.teal, 'blocked': Colors.deepOrange,
};

class MissionsScreen extends ConsumerWidget {
  const MissionsScreen({super.key});

  Future<void> _create(BuildContext context, WidgetRef ref) async {
    final goalCtl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Yeni Mission'),
        content: TextField(controller: goalCtl, maxLines: 3, decoration: const InputDecoration(labelText: 'Hedef (goal)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Vazgeç')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Başlat')),
        ],
      ),
    );
    if (ok != true || goalCtl.text.trim().isEmpty) return;
    try {
      await ref.read(sessionProvider)!.api.post('/missions', body: {'goal': goalCtl.text.trim()});
      ref.invalidate(missionsProvider);
    } catch (e) {
      if (context.mounted) {
        ScaffoldMessenger.of(context).showSnackBar(SnackBar(content: Text('Mission başlatılamadı: $e')));
      }
    }
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(missionsProvider);
    final canManage = ref.watch(sessionProvider)?.canManage ?? false;
    return Scaffold(
      appBar: AppBar(title: const Text('Missionlar')),
      floatingActionButton: canManage
          ? FloatingActionButton(onPressed: () => _create(context, ref), child: const Icon(Icons.add))
          : null,
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (items) => RefreshIndicator(
          onRefresh: () async => ref.invalidate(missionsProvider),
          child: ListView.builder(
            itemCount: items.length,
            itemBuilder: (_, i) {
              final m = items[i];
              final status = (m['status'] ?? '?').toString();
              return ListTile(
                leading: Icon(Icons.rocket_launch, color: missionStatusColors[status] ?? Colors.grey),
                title: Text((m['title'] ?? m['goal'] ?? '?').toString(), maxLines: 1, overflow: TextOverflow.ellipsis),
                subtitle: Text('$status · ${(m['_count']?['tasks'] ?? 0)} görev'),
                onTap: () => context.push('/missions/${m['id']}'),
              );
            },
          ),
        ),
      ),
    );
  }
}

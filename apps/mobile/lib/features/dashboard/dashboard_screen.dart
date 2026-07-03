import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';

final _summary = FutureProvider.autoDispose<Map<String, dynamic>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  return ((await api.get('/dashboard/summary')) as Map).cast<String, dynamic>();
});

class DashboardScreen extends ConsumerWidget {
  const DashboardScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final summary = ref.watch(_summary);
    final session = ref.watch(sessionProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Daha'), actions: [
        IconButton(
          icon: const Icon(Icons.logout),
          onPressed: () async {
            await ref.read(authRepositoryProvider).logout();
            if (context.mounted) context.go('/login');
          },
        ),
      ]),
      body: summary.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (s) => GridView.count(
          padding: const EdgeInsets.all(16),
          crossAxisCount: 2,
          mainAxisSpacing: 12,
          crossAxisSpacing: 12,
          childAspectRatio: 1.4,
          children: [
            _kpi('İşlenen Aktivite', '${s['activitiesHandled'] ?? '—'}'),
            _kpi('Bekleyen Onay', '${s['pendingApprovals'] ?? '—'}'),
            _kpi('Eskalasyon', '${s['escalations'] ?? '—'}'),
            _kpi('Agent Çalıştırma', '${s['agentRuns'] ?? '—'}'),
            _kpi('Ort. Güven', s['avgConfidence'] != null ? '%${((s['avgConfidence'] as num) * 100).round()}' : '—'),
            _kpi('Kazanılan Süre', '${s['timeSavedMins'] ?? '—'} dk'),
            _kpi('Kullanıcı', session?.user['displayName']?.toString() ?? '—'),
          ],
        ),
      ),
    );
  }

  Widget _kpi(String label, String value) => Card(
        child: Padding(
          padding: const EdgeInsets.all(12),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, mainAxisAlignment: MainAxisAlignment.center, children: [
            Text(value, style: const TextStyle(fontSize: 24, fontWeight: FontWeight.bold)),
            const SizedBox(height: 4),
            Text(label, style: const TextStyle(fontSize: 12, color: Colors.white70)),
          ]),
        ),
      );
}

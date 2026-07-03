import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api_error_view.dart';
import '../../core/session.dart';
import 'missions_screen.dart';

final _missionDetail = FutureProvider.autoDispose.family<Map<String, dynamic>, String>((ref, id) async {
  final api = ref.watch(sessionProvider)!.api;
  return ((await api.get('/missions/$id')) as Map).cast<String, dynamic>();
});

class MissionDetailScreen extends ConsumerWidget {
  const MissionDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(_missionDetail(id));
    return Scaffold(
      appBar: AppBar(title: const Text('Mission')),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ApiErrorView(error: e, onRetry: () => ref.invalidate(_missionDetail(id))),
        data: (d) {
          final mission = ((d['mission'] ?? d) as Map).cast<String, dynamic>();
          final tasks = (d['tasks'] as List? ?? const []).cast<Map>();
          final status = (mission['status'] ?? '?').toString();
          return ListView(padding: const EdgeInsets.all(16), children: [
            Text((mission['title'] ?? '?').toString(), style: Theme.of(context).textTheme.titleLarge),
            const SizedBox(height: 8),
            Chip(label: Text(status), backgroundColor: (missionStatusColors[status] ?? Colors.grey).withValues(alpha: 0.2)),
            const SizedBox(height: 8),
            Text((mission['goal'] ?? '').toString()),
            const Divider(height: 32),
            Text('Görevler (${tasks.length})', style: Theme.of(context).textTheme.titleMedium),
            for (final t in tasks)
              ListTile(
                dense: true,
                leading: Icon(
                  t['status'] == 'done' ? Icons.check_circle : (t['status'] == 'in_progress' ? Icons.timelapse : Icons.circle_outlined),
                  color: t['status'] == 'done' ? Colors.teal : Colors.grey,
                ),
                title: Text((t['title'] ?? '?').toString(), maxLines: 2),
                subtitle: Text((t['status'] ?? '').toString()),
              ),
          ]);
        },
      ),
    );
  }
}

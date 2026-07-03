import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/session.dart';

final _activityDetail = FutureProvider.autoDispose.family<Map<String, dynamic>, String>((ref, id) async {
  final api = ref.watch(sessionProvider)!.api;
  return ((await api.get('/activities/$id')) as Map).cast<String, dynamic>();
});

class ActivityDetailScreen extends ConsumerWidget {
  const ActivityDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(_activityDetail(id));
    return Scaffold(
      appBar: AppBar(title: const Text('Aktivite')),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (a) => ListView(padding: const EdgeInsets.all(16), children: [
          Text((a['subject'] ?? '(konu yok)').toString(), style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            Chip(label: Text('${a['channel']}')),
            Chip(label: Text('${a['status']}')),
            if (a['priority'] != null) Chip(label: Text('${a['priority']}')),
          ]),
          const Divider(height: 32),
          SelectableText((a['body'] ?? '').toString()),
        ]),
      ),
    );
  }
}

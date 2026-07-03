import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';
import '../approvals/approvals_models.dart';

final _statusFilter = StateProvider<String?>((_) => null);

final activitiesProvider = FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  final status = ref.watch(_statusFilter);
  final body = await api.get('/activities', query: {
    'pageSize': '50',
    if (status != null) 'status': status,
  });
  return unwrapList(body);
});

const _statuses = ['new', 'watching', 'in_progress', 'awaiting_approval', 'completed', 'escalated'];

class InboxScreen extends ConsumerWidget {
  const InboxScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(activitiesProvider);
    final selected = ref.watch(_statusFilter);
    return Scaffold(
      appBar: AppBar(title: const Text('Gelen Kutusu')),
      body: Column(children: [
        SizedBox(
          height: 48,
          child: ListView(scrollDirection: Axis.horizontal, padding: const EdgeInsets.symmetric(horizontal: 12), children: [
            for (final s in _statuses)
              Padding(
                padding: const EdgeInsets.only(right: 8),
                child: FilterChip(
                  label: Text(s),
                  selected: selected == s,
                  onSelected: (_) => ref.read(_statusFilter.notifier).state = selected == s ? null : s,
                ),
              ),
          ]),
        ),
        Expanded(
          child: list.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (e, _) => Center(child: Text('Hata: $e')),
            data: (items) => RefreshIndicator(
              onRefresh: () async => ref.invalidate(activitiesProvider),
              child: ListView.builder(
                itemCount: items.length,
                itemBuilder: (_, i) {
                  final a = items[i];
                  final channel = (a['channel'] ?? '').toString();
                  return ListTile(
                    leading: CircleAvatar(child: Text(channel.isEmpty ? '?' : channel[0].toUpperCase())),
                    title: Text((a['subject'] ?? '(konu yok)').toString(), maxLines: 1, overflow: TextOverflow.ellipsis),
                    subtitle: Text('${channel.isEmpty ? '?' : channel} · ${a['status']}'),
                    onTap: () => context.push('/inbox/${a['id']}'),
                  );
                },
              ),
            ),
          ),
        ),
      ]),
    );
  }
}

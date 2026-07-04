import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api_error_view.dart';
import '../../core/session.dart';
import '../../ui/components/components.dart';
import '../approvals/approvals_models.dart';

final _statusFilter = StateProvider.autoDispose<String?>((_) => null);

final activitiesProvider =
    FutureProvider.autoDispose<List<Map<String, dynamic>>>((ref) async {
      final api = ref.watch(sessionProvider)!.api;
      final status = ref.watch(_statusFilter);
      final body = await api.get(
        '/activities',
        query: {'pageSize': '50', if (status != null) 'status': status},
      );
      return unwrapList(body);
    });

const _statuses = [
  'new',
  'watching',
  'in_progress',
  'awaiting_approval',
  'completed',
  'escalated',
];

class InboxScreen extends ConsumerWidget {
  const InboxScreen({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final list = ref.watch(activitiesProvider);
    final selected = ref.watch(_statusFilter);
    return Scaffold(
      body: SafeArea(
        child: Column(
          children: [
            const Padding(
              padding: EdgeInsets.fromLTRB(16, 18, 16, 0),
              child: PageHeader(
                title: 'Gelen Kutusu',
                subtitle: 'Kanallar arası iş akışı sinyalleri',
              ),
            ),
            SizedBox(
              height: 46,
              child: ListView(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.symmetric(horizontal: 16),
                children: [
                  for (final s in _statuses)
                    Padding(
                      padding: const EdgeInsets.only(right: 8),
                      child: FilterChip(
                        label: Text(s),
                        selected: selected == s,
                        onSelected: (_) =>
                            ref.read(_statusFilter.notifier).state =
                                selected == s ? null : s,
                      ),
                    ),
                ],
              ),
            ),
            Expanded(
              child: list.when(
                loading: () => const Center(child: CircularProgressIndicator()),
                error: (e, _) => ApiErrorView(
                  error: e,
                  onRetry: () => ref.invalidate(activitiesProvider),
                ),
                data: (items) => RefreshIndicator(
                  onRefresh: () async => ref.invalidate(activitiesProvider),
                  child: ListView(
                    physics: const AlwaysScrollableScrollPhysics(),
                    padding: const EdgeInsets.fromLTRB(16, 8, 16, 24),
                    children: [
                      if (items.isEmpty)
                        const EmptyState(
                          icon: Icons.inbox_outlined,
                          title: 'Gelen kutusu boş',
                        )
                      else
                        for (final a in items) ...[
                          DynCard(
                            padding: 16,
                            onTap: () => context.push('/inbox/${a['id']}'),
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    ChannelChip(
                                      (a['channel'] ?? '').toString(),
                                    ),
                                    const SizedBox(width: 8),
                                    StatusBadge(
                                      (a['status'] ?? 'new').toString(),
                                    ),
                                  ],
                                ),
                                const SizedBox(height: 10),
                                Text(
                                  (a['subject'] ?? '(konu yok)').toString(),
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
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
          ],
        ),
      ),
    );
  }
}

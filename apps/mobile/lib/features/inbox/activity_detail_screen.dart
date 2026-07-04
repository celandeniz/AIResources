import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api_error_view.dart';
import '../../core/session.dart';
import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';
import '../../ui/tokens/tokens.dart';

final _activityDetail = FutureProvider.autoDispose
    .family<Map<String, dynamic>, String>((ref, id) async {
      final api = ref.watch(sessionProvider)!.api;
      return ((await api.get('/activities/$id')) as Map)
          .cast<String, dynamic>();
    });

class ActivityDetailScreen extends ConsumerWidget {
  const ActivityDetailScreen({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(_activityDetail(id));
    return Scaffold(
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ApiErrorView(
          error: e,
          onRetry: () => ref.invalidate(_activityDetail(id)),
        ),
        data: (a) {
          final c = dynColorsFor(context);
          return SafeArea(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
              children: [
                PageHeader(
                  title: (a['subject'] ?? '(konu yok)').toString(),
                  subtitle: 'Aktivite detayı',
                ),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    ChannelChip('${a['channel'] ?? ''}'),
                    StatusBadge('${a['status'] ?? 'new'}'),
                    if (a['priority'] != null)
                      DynBadge(
                        variant: DynBadgeVariant.neutral,
                        child: Text('${a['priority']}'),
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                DynCard(
                  child: SelectableText(
                    (a['body'] ?? '').toString(),
                    style: DynType.body(c),
                  ),
                ),
              ],
            ),
          );
        },
      ),
    );
  }
}

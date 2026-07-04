import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/api_error_view.dart';
import '../../core/session.dart';
import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';
import '../../ui/tokens/tokens.dart';

final _missionDetail = FutureProvider.autoDispose
    .family<Map<String, dynamic>, String>((ref, id) async {
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
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ApiErrorView(
          error: e,
          onRetry: () => ref.invalidate(_missionDetail(id)),
        ),
        data: (d) {
          final c = dynColorsFor(context);
          final mission = ((d['mission'] ?? d) as Map).cast<String, dynamic>();
          final tasks = (d['tasks'] as List? ?? const []).cast<Map>();
          final status = (mission['status'] ?? '?').toString();
          return SafeArea(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
              children: [
                PageHeader(
                  title: (mission['title'] ?? '?').toString(),
                  subtitle: 'Mission detayı',
                ),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    StatusBadge(status),
                    DynBadge(
                      variant: DynBadgeVariant.neutral,
                      child: Text('${tasks.length} görev'),
                    ),
                  ],
                ),
                const SizedBox(height: 16),
                DynCard(
                  child: Text(
                    (mission['goal'] ?? '').toString(),
                    style: DynType.body(c),
                  ),
                ),
                const SizedBox(height: 20),
                SectionTitle('Görevler (${tasks.length})'),
                const SizedBox(height: 10),
                if (tasks.isEmpty)
                  const EmptyState(icon: Icons.task_alt, title: 'Görev yok')
                else
                  for (final t in tasks) ...[
                    DynCard(
                      padding: 14,
                      child: Row(
                        children: [
                          Icon(
                            t['status'] == 'done'
                                ? Icons.check_circle
                                : (t['status'] == 'in_progress'
                                      ? Icons.timelapse
                                      : Icons.circle_outlined),
                            color: t['status'] == 'done'
                                ? c.success
                                : c.mutedFg,
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(
                                  (t['title'] ?? '?').toString(),
                                  maxLines: 2,
                                  overflow: TextOverflow.ellipsis,
                                ),
                                const SizedBox(height: 6),
                                StatusBadge((t['status'] ?? '').toString()),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                    const SizedBox(height: 10),
                  ],
              ],
            ),
          );
        },
      ),
    );
  }
}

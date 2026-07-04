import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api_error_view.dart';
import '../../core/session.dart';
import '../../ui/charts/charts.dart';
import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';

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
      body: summary.when(
        loading: () => SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
            children: const [
              PageHeader(
                title: 'Komuta merkezi',
                subtitle: 'Operasyon sağlığı ve karar temposu',
              ),
              _KpiSkeletonGrid(),
            ],
          ),
        ),
        error: (e, _) =>
            ApiErrorView(error: e, onRetry: () => ref.invalidate(_summary)),
        data: (s) => SafeArea(
          child: ListView(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
            children: [
              PageHeader(
                title: 'Komuta merkezi',
                subtitle:
                    session?.user['displayName']?.toString() ??
                    'Operasyon sağlığı ve karar temposu',
                actions: [
                  DynButton(
                    size: DynButtonSize.icon,
                    variant: DynButtonVariant.ghost,
                    onPressed: () => ref.invalidate(_summary),
                    child: const Icon(Icons.refresh),
                  ),
                  DynButton(
                    size: DynButtonSize.icon,
                    variant: DynButtonVariant.ghost,
                    onPressed: () async {
                      await ref.read(authRepositoryProvider).logout();
                      if (context.mounted) context.go('/login');
                    },
                    child: const Icon(Icons.logout),
                  ),
                ],
              ),
              LayoutBuilder(
                builder: (context, constraints) {
                  final tileWidth = (constraints.maxWidth - 12) / 2;
                  return Wrap(
                    spacing: 12,
                    runSpacing: 12,
                    children: [
                      SizedBox(
                        width: tileWidth,
                        child: KpiCard(
                          label: 'Toplantılar',
                          value: '→',
                          sub: 'Bekleyen kararlar',
                          onTap: () => context.push('/meetings'),
                        ),
                      ),
                      SizedBox(
                        width: tileWidth,
                        child: KpiCard(
                          label: 'İşlenen',
                          value: '${s['activitiesHandled'] ?? '—'}',
                          spark: _series(s['activitiesSeries']),
                        ),
                      ),
                      SizedBox(
                        width: tileWidth,
                        child: KpiCard(
                          label: 'Onaylar',
                          value: '${s['pendingApprovals'] ?? '—'}',
                          accent: DynAccent.warning,
                        ),
                      ),
                      SizedBox(
                        width: tileWidth,
                        child: KpiCard(
                          label: 'Eskalasyon',
                          value: '${s['escalations'] ?? '—'}',
                          accent: DynAccent.danger,
                        ),
                      ),
                      SizedBox(
                        width: tileWidth,
                        child: KpiCard(
                          label: 'Agent',
                          value: '${s['agentRuns'] ?? '—'}',
                          spark: _series(s['agentRunsSeries']),
                        ),
                      ),
                      SizedBox(
                        width: tileWidth,
                        child: KpiCard(
                          label: 'Güven',
                          value: _confidence(s['avgConfidence']),
                          accent: DynAccent.success,
                        ),
                      ),
                      SizedBox(
                        width: tileWidth,
                        child: KpiCard(
                          label: 'Süre',
                          value: '${s['timeSavedMins'] ?? '—'} dk',
                        ),
                      ),
                      SizedBox(
                        width: tileWidth,
                        child: KpiCard(
                          label: 'Kullanıcı',
                          value: session?.role ?? '—',
                          sub: session?.user['displayName']?.toString(),
                        ),
                      ),
                    ],
                  );
                },
              ),
              if (_donutData(context, s).isNotEmpty) ...[
                const SizedBox(height: 20),
                const SectionTitle('AI / İnsan'),
                const SizedBox(height: 10),
                DynCard(
                  child: DonutChart(
                    data: _donutData(context, s),
                    centerLabel: '${_donutTotal(s)}',
                  ),
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }

  static String _confidence(Object? value) =>
      value is num ? '%${(value * 100).round()}' : '—';

  static List<double>? _series(Object? value) {
    if (value is! List) return null;
    final values = value
        .map((e) => e is num ? e.toDouble() : double.tryParse('$e'))
        .whereType<double>()
        .toList();
    return values.length < 2 ? null : values;
  }

  List<({String name, double value, Color color})> _donutData(
    BuildContext context,
    Map<String, dynamic> s,
  ) {
    final c = dynColorsFor(context);
    final ai = _num(s['aiHandled'] ?? s['ai']);
    final human = _num(s['humanHandled'] ?? s['human']);
    if (ai == null || human == null) return const [];
    return [
      (name: 'AI', value: ai, color: c.primary),
      (name: 'İnsan', value: human, color: c.success),
    ];
  }

  static int _donutTotal(Map<String, dynamic> s) {
    final ai = _num(s['aiHandled'] ?? s['ai']) ?? 0;
    final human = _num(s['humanHandled'] ?? s['human']) ?? 0;
    return (ai + human).round();
  }

  static double? _num(Object? value) {
    if (value is num) return value.toDouble();
    if (value is String) return double.tryParse(value);
    return null;
  }
}

class _KpiSkeletonGrid extends StatelessWidget {
  const _KpiSkeletonGrid();

  @override
  Widget build(BuildContext context) => LayoutBuilder(
    builder: (context, constraints) {
      final tileWidth = (constraints.maxWidth - 12) / 2;
      return Wrap(
        spacing: 12,
        runSpacing: 12,
        children: [
          for (var i = 0; i < 6; i++)
            SizedBox(
              width: tileWidth,
              child: const DynCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Skeleton(width: 72, height: 12),
                    SizedBox(height: 14),
                    Skeleton(width: 92, height: 32),
                    SizedBox(height: 12),
                    Skeleton(width: double.infinity, height: 36),
                  ],
                ),
              ),
            ),
        ],
      );
    },
  );
}

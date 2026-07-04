import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api_error_view.dart';
import '../../core/session.dart';
import '../../core/sse.dart';
import '../../ui/components/components.dart';
import 'approvals_repository.dart';

class ApprovalsScreen extends ConsumerStatefulWidget {
  const ApprovalsScreen({super.key});
  @override
  ConsumerState<ApprovalsScreen> createState() => _ApprovalsScreenState();
}

class _ApprovalsScreenState extends ConsumerState<ApprovalsScreen> {
  final selected = <String>{};
  SseClient? _sse;
  Timer? _poll;

  @override
  void initState() {
    super.initState();
    final api = ref.read(sessionProvider)!.api;
    _sse = SseClient(
      api.streamUrl(),
      onEvent: (event, _) {
        if (event == 'approval' || event == 'activity') {
          ref.invalidate(approvalsListProvider);
        }
      },
      onDown: () {
        _poll ??= Timer.periodic(
          const Duration(seconds: 8),
          (_) => ref.invalidate(approvalsListProvider),
        );
      },
    );
    _sse!.connect();
  }

  @override
  void dispose() {
    _sse?.close();
    _poll?.cancel();
    super.dispose();
  }

  Future<void> _bulk(String action) async {
    await ref.read(approvalActionsProvider).bulk(selected.toList(), action);
    if (!mounted) return;
    setState(() => selected.clear());
    ref.invalidate(approvalsListProvider);
  }

  @override
  Widget build(BuildContext context) {
    final list = ref.watch(approvalsListProvider);
    final canDecide = ref.watch(sessionProvider)?.canDecide ?? false;
    return Scaffold(
      bottomNavigationBar: selected.isEmpty || !canDecide
          ? null
          : BottomAppBar(
              padding: const EdgeInsets.fromLTRB(16, 10, 16, 14),
              child: Row(
                children: [
                  Text('${selected.length} seçili'),
                  const Spacer(),
                  DynButton(
                    variant: DynButtonVariant.danger,
                    size: DynButtonSize.sm,
                    onPressed: () => _bulk('reject'),
                    child: const Text('Reddet'),
                  ),
                  const SizedBox(width: 8),
                  DynButton(
                    variant: DynButtonVariant.success,
                    size: DynButtonSize.sm,
                    onPressed: () => _bulk('approve'),
                    child: const Text('Onayla'),
                  ),
                ],
              ),
            ),
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ApiErrorView(
          error: e,
          onRetry: () => ref.invalidate(approvalsListProvider),
        ),
        data: (items) => SafeArea(
          child: RefreshIndicator(
            onRefresh: () async => ref.invalidate(approvalsListProvider),
            child: ListView(
              physics: const AlwaysScrollableScrollPhysics(),
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 24),
              children: [
                PageHeader(
                  title: 'Onaylar',
                  subtitle: 'İnsan kararı gerektiren güvenli taslaklar',
                  actions: [
                    DynButton(
                      size: DynButtonSize.icon,
                      variant: DynButtonVariant.ghost,
                      onPressed: () => ref.invalidate(approvalsListProvider),
                      child: const Icon(Icons.refresh),
                    ),
                  ],
                ),
                if (items.isEmpty)
                  const EmptyState(
                    icon: Icons.check_circle_outline,
                    title: 'Bekleyen onay yok',
                  )
                else
                  for (final a in items) ...[
                    _ApprovalRow(
                      approval: a,
                      canDecide: canDecide,
                      selected: selected.contains(a.id),
                      onSelect: () => setState(
                        () => selected.contains(a.id)
                            ? selected.remove(a.id)
                            : selected.add(a.id),
                      ),
                      onTap: () => context.push('/approvals/${a.id}'),
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

class _ApprovalRow extends StatelessWidget {
  const _ApprovalRow({
    required this.approval,
    required this.canDecide,
    required this.selected,
    required this.onSelect,
    required this.onTap,
  });

  final dynamic approval;
  final bool canDecide;
  final bool selected;
  final VoidCallback onSelect;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return DynCard(
      glow: selected,
      padding: 16,
      onTap: onTap,
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          if (canDecide) ...[
            Checkbox(value: selected, onChanged: (_) => onSelect()),
            const SizedBox(width: 8),
          ],
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  approval.subject ?? approval.reason ?? approval.action,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                const SizedBox(height: 8),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    StatusBadge(approval.status),
                    DynBadge(
                      variant: _riskVariant(approval.riskLevel),
                      leadingDot: true,
                      child: Text(approval.riskLevel),
                    ),
                    if ((approval.channel ?? '').isNotEmpty)
                      ChannelChip(approval.channel),
                  ],
                ),
              ],
            ),
          ),
          if (approval.confidence != null) ...[
            const SizedBox(width: 12),
            ConfidenceDial(value: approval.confidence, size: 52),
          ],
        ],
      ),
    );
  }
}

DynBadgeVariant _riskVariant(String risk) => switch (risk.toLowerCase()) {
  'low' => DynBadgeVariant.success,
  'medium' => DynBadgeVariant.warning,
  'high' => DynBadgeVariant.danger,
  'critical' => DynBadgeVariant.danger,
  _ => DynBadgeVariant.neutral,
};

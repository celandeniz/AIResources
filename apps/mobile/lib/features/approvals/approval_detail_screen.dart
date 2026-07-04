import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/api_error_view.dart';
import '../../core/session.dart';
import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';
import '../../ui/tokens/tokens.dart';
import 'approvals_repository.dart';

class ApprovalDetailScreen extends ConsumerWidget {
  const ApprovalDetailScreen({super.key, required this.id});
  final String id;

  Future<void> _decide(
    BuildContext context,
    WidgetRef ref,
    String action,
  ) async {
    final noteCtl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(action == 'approve' ? 'Onayla' : 'Reddet'),
        content: TextField(
          controller: noteCtl,
          decoration: const InputDecoration(
            labelText: 'Not (opsiyonel / red için zorunlu)',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(ctx, false),
            child: const Text('Vazgeç'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(ctx, true),
            child: const Text('Tamam'),
          ),
        ],
      ),
    );
    if (ok != true) return;
    final actions = ref.read(approvalActionsProvider);
    if (action == 'approve') {
      await actions.approve(id, note: noteCtl.text);
    } else {
      await actions.reject(
        id,
        note: noteCtl.text.isEmpty ? 'Mobilden reddedildi' : noteCtl.text,
      );
    }
    ref.invalidate(approvalsListProvider);
    if (context.mounted) context.pop();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(approvalDetailProvider(id));
    final canDecide = ref.watch(sessionProvider)?.canDecide ?? false;
    return Scaffold(
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ApiErrorView(
          error: e,
          onRetry: () => ref.invalidate(approvalDetailProvider(id)),
        ),
        data: (a) {
          final c = dynColorsFor(context);
          return SafeArea(
            child: ListView(
              padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
              children: [
                PageHeader(
                  title: a.subject ?? a.action,
                  subtitle: 'Onay detayı ve karar gerekçesi',
                ),
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    DynBadge(
                      variant: DynBadgeVariant.outline,
                      child: Text(a.action),
                    ),
                    StatusBadge(a.status),
                    DynBadge(
                      variant: _riskVariant(a.riskLevel),
                      leadingDot: true,
                      child: Text('risk: ${a.riskLevel}'),
                    ),
                    if (a.amount != null)
                      DynBadge(
                        variant: DynBadgeVariant.neutral,
                        child: Text('tutar: ${a.amount}'),
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                DynCard(
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      ConfidenceDial(value: a.confidence ?? 0, size: 88),
                      const SizedBox(width: 18),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            const SectionTitle('Açıklanabilirlik'),
                            const SizedBox(height: 10),
                            Text(
                              a.reason ?? 'Gerekçe bilgisi yok.',
                              style: DynType.body(c),
                            ),
                            if (a.tokenCost != null ||
                                a.citations.isNotEmpty) ...[
                              const SizedBox(height: 14),
                              Wrap(
                                spacing: 8,
                                runSpacing: 8,
                                children: [
                                  if (a.tokenCost != null)
                                    DynBadge(
                                      variant: DynBadgeVariant.neutral,
                                      child: Text('token: ${a.tokenCost}'),
                                    ),
                                  for (final cite in a.citations)
                                    DynBadge(
                                      variant: DynBadgeVariant.outline,
                                      child: Text(cite),
                                    ),
                                ],
                              ),
                            ],
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: 16),
                const SectionTitle('Taslak'),
                const SizedBox(height: 8),
                DynCard(
                  padding: 16,
                  child: SelectableText(
                    a.draftText ?? '(taslak metni yok)',
                    style: DynType.mono(c),
                  ),
                ),
                const SizedBox(height: 24),
                if (canDecide)
                  Row(
                    children: [
                      Expanded(
                        child: DynButton(
                          variant: DynButtonVariant.danger,
                          onPressed: () => _decide(context, ref, 'reject'),
                          child: const Text('Reddet'),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: DynButton(
                          variant: DynButtonVariant.success,
                          onPressed: () => _decide(context, ref, 'approve'),
                          child: const Text('Onayla'),
                        ),
                      ),
                    ],
                  ),
              ],
            ),
          );
        },
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

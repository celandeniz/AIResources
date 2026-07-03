import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';
import 'approvals_repository.dart';

class ApprovalDetailScreen extends ConsumerWidget {
  const ApprovalDetailScreen({super.key, required this.id});
  final String id;

  Future<void> _decide(BuildContext context, WidgetRef ref, String action) async {
    final noteCtl = TextEditingController();
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: Text(action == 'approve' ? 'Onayla' : 'Reddet'),
        content: TextField(controller: noteCtl, decoration: const InputDecoration(labelText: 'Not (opsiyonel / red için zorunlu)')),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Vazgeç')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Tamam')),
        ],
      ),
    );
    if (ok != true) return;
    final actions = ref.read(approvalActionsProvider);
    if (action == 'approve') {
      await actions.approve(id, note: noteCtl.text);
    } else {
      await actions.reject(id, note: noteCtl.text.isEmpty ? 'Mobilden reddedildi' : noteCtl.text);
    }
    ref.invalidate(approvalsListProvider);
    if (context.mounted) context.pop();
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final detail = ref.watch(approvalDetailProvider(id));
    final canDecide = ref.watch(sessionProvider)?.canDecide ?? false;
    return Scaffold(
      appBar: AppBar(title: const Text('Onay Detayı')),
      body: detail.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (a) => ListView(padding: const EdgeInsets.all(16), children: [
          Text(a.subject ?? a.action, style: Theme.of(context).textTheme.titleLarge),
          const SizedBox(height: 8),
          Wrap(spacing: 8, children: [
            Chip(label: Text(a.action)),
            Chip(label: Text('risk: ${a.riskLevel}')),
            if (a.amount != null) Chip(label: Text('tutar: ${a.amount}')),
          ]),
          if (a.reason != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(a.reason!)),
          const Divider(height: 32),
          Text('Taslak', style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 8),
          Card(child: Padding(padding: const EdgeInsets.all(12), child: SelectableText(a.draftText ?? '(taslak metni yok)'))),
          const SizedBox(height: 24),
          if (canDecide)
            Row(children: [
              Expanded(child: OutlinedButton(onPressed: () => _decide(context, ref, 'reject'), child: const Text('Reddet'))),
              const SizedBox(width: 12),
              Expanded(child: FilledButton(onPressed: () => _decide(context, ref, 'approve'), child: const Text('Onayla'))),
            ]),
        ]),
      ),
    );
  }
}

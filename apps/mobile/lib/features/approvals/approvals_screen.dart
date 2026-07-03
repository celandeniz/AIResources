import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../../core/session.dart';
import '../../core/sse.dart';
import 'approvals_repository.dart';

const riskColors = {
  'low': Colors.teal, 'medium': Colors.amber, 'high': Colors.deepOrange, 'critical': Colors.red,
};

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
    _sse = SseClient(api.streamUrl(), onEvent: (event, _) {
      if (event == 'approval' || event == 'activity') ref.invalidate(approvalsListProvider);
    }, onDown: () {
      _poll ??= Timer.periodic(const Duration(seconds: 8), (_) => ref.invalidate(approvalsListProvider));
    });
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
    setState(() => selected.clear());
    ref.invalidate(approvalsListProvider);
  }

  @override
  Widget build(BuildContext context) {
    final list = ref.watch(approvalsListProvider);
    final canDecide = ref.watch(sessionProvider)?.canDecide ?? false;
    return Scaffold(
      appBar: AppBar(title: const Text('Onaylar'), actions: [
        IconButton(icon: const Icon(Icons.refresh), onPressed: () => ref.invalidate(approvalsListProvider)),
      ]),
      bottomNavigationBar: selected.isEmpty || !canDecide
          ? null
          : BottomAppBar(
              child: Row(children: [
                Text('${selected.length} seçili'),
                const Spacer(),
                TextButton(onPressed: () => _bulk('reject'), child: const Text('Reddet')),
                FilledButton(onPressed: () => _bulk('approve'), child: const Text('Onayla')),
              ]),
            ),
      body: list.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => Center(child: Text('Hata: $e')),
        data: (items) => items.isEmpty
            ? const Center(child: Text('Bekleyen onay yok 🎉'))
            : RefreshIndicator(
                onRefresh: () async => ref.invalidate(approvalsListProvider),
                child: ListView.builder(
                  itemCount: items.length,
                  itemBuilder: (_, i) {
                    final a = items[i];
                    final sel = selected.contains(a.id);
                    return ListTile(
                      leading: canDecide
                          ? Checkbox(value: sel, onChanged: (_) => setState(() => sel ? selected.remove(a.id) : selected.add(a.id)))
                          : const Icon(Icons.pending_outlined),
                      title: Text(a.subject ?? a.reason ?? a.action, maxLines: 1, overflow: TextOverflow.ellipsis),
                      subtitle: Text(a.action),
                      trailing: Chip(
                        label: Text(a.riskLevel),
                        backgroundColor: (riskColors[a.riskLevel] ?? Colors.grey).withValues(alpha: 0.2),
                      ),
                      onTap: () => context.push('/approvals/${a.id}'),
                    );
                  },
                ),
              ),
      ),
    );
  }
}

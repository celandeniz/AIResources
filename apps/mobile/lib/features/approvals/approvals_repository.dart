import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/session.dart';
import 'approvals_models.dart';

final approvalsListProvider = FutureProvider.autoDispose<List<Approval>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/approvals', query: {'status': 'pending'});
  return unwrapList(body).map(Approval.fromJson).toList();
});

final approvalDetailProvider = FutureProvider.autoDispose.family<Approval, String>((ref, id) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/approvals/$id');
  final map = (body is Map && body['approval'] is Map ? body['approval'] : body) as Map;
  return Approval.fromJson(map.cast<String, dynamic>());
});

class ApprovalActions {
  ApprovalActions(this.ref);
  final Ref ref;
  Future<void> approve(String id, {String? note}) async =>
      ref.read(sessionProvider)!.api.post('/approvals/$id/approve', body: {'note': note ?? ''});
  Future<void> reject(String id, {required String note}) async =>
      ref.read(sessionProvider)!.api.post('/approvals/$id/reject', body: {'note': note});
  Future<void> bulk(List<String> ids, String action) async =>
      ref.read(sessionProvider)!.api.post('/approvals/bulk', body: {'ids': ids, 'action': action});
}

final approvalActionsProvider = Provider((ref) => ApprovalActions(ref));

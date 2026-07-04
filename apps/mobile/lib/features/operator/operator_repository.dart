import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../core/session.dart';
import '../approvals/approvals_models.dart' show unwrapList;
import 'operator_models.dart';

final operatorCommandsProvider =
    FutureProvider.autoDispose<List<DeviceCommand>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/devices/commands', query: {'status': 'approved'});
  final rows = body is Map && body['commands'] is List
      ? (body['commands'] as List)
          .map((item) => (item as Map).cast<String, dynamic>())
          .toList()
      : unwrapList(body);
  return rows.map(DeviceCommand.fromJson).toList();
});

class OperatorActions {
  OperatorActions(this.ref);
  final Ref ref;

  Future<void> postResult(
    String id, {
    required bool succeeded,
    required List<Map<String, dynamic>> steps,
    String? detail,
  }) async {
    final api = ref.read(sessionProvider)!.api;
    await api.post('/devices/commands/$id/result', body: {
      'status': succeeded ? 'succeeded' : 'failed',
      'steps': steps,
      if (detail != null) 'detail': detail,
    });
  }
}

final operatorActionsProvider = Provider((ref) => OperatorActions(ref));

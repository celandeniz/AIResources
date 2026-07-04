import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/session.dart';
import '../approvals/approvals_models.dart';
import 'chat_models.dart';

final chatResourcesProvider =
    FutureProvider.autoDispose<List<ChatResource>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/ai-resources', query: {'active': 'true'});
  return unwrapList(body).map(ChatResource.fromJson).toList();
});

final chatThreadsProvider =
    FutureProvider.autoDispose<List<ChatThread>>((ref) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/chat/threads');
  return unwrapList(body).map(ChatThread.fromJson).toList();
});

final chatMessagesProvider =
    FutureProvider.autoDispose.family<List<ChatMessage>, String>((
  ref,
  threadId,
) async {
  final api = ref.watch(sessionProvider)!.api;
  final body = await api.get('/chat/threads/$threadId/messages') as Map;
  final list = body['messages'] as List? ?? const [];
  return list
      .map((item) => ChatMessage.fromJson((item as Map).cast<String, dynamic>()))
      .toList();
});

class ChatActions {
  ChatActions(this.ref);

  final Ref ref;

  Future<ChatSendResult> send({
    required String resourceKey,
    required String message,
    String? threadId,
  }) async {
    final api = ref.read(sessionProvider)!.api;
    final body = await api.post('/chat', body: {
      'resource_key': resourceKey,
      'message': message,
      if (threadId != null) 'thread_id': threadId,
    }) as Map;
    return ChatSendResult.fromJson(body.cast<String, dynamic>());
  }
}

final chatActionsProvider = Provider((ref) => ChatActions(ref));

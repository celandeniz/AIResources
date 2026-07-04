import 'package:dynops_mobile/features/chat/chat_models.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('parses ai-resources list for the picker', () {
    final resource = ChatResource.fromJson({
      'id': 'r1',
      'key': 'ai_executive_assistant',
      'name': 'Executive Assistant',
      'role': 'EA',
      'status': 'active',
    });
    expect(resource.key, 'ai_executive_assistant');
    expect(resource.name, 'Executive Assistant');
  });

  test('parses a chat thread summary', () {
    final thread = ChatThread.fromJson({
      'id': 'th1',
      'subject': 'Merhaba, kisaca kendini tanit.',
      'status': 'in_progress',
      'resource': {
        'id': 'r1',
        'key': 'ai_executive_assistant',
        'name': 'Executive Assistant',
      },
      'last_message': 'Merhaba! Ben...',
      'last_message_at': '2026-07-04T10:00:00Z',
    });
    expect(thread.subject, 'Merhaba, kisaca kendini tanit.');
    expect(thread.resourceName, 'Executive Assistant');
    expect(thread.lastMessage, 'Merhaba! Ben...');
  });

  test('parses chat messages with direction', () {
    final message = ChatMessage.fromJson({
      'id': 'm1',
      'direction': 'inbound',
      'author_type': 'user',
      'body': 'Selam',
      'created_at': '2026-07-04T10:00:00Z',
    });
    expect(message.isUser, true);
    expect(message.body, 'Selam');

    final reply = ChatMessage.fromJson({
      'id': 'm2',
      'direction': 'outbound',
      'author_type': 'ai_resource',
      'body': 'Merhaba!',
      'created_at': '2026-07-04T10:00:05Z',
    });
    expect(reply.isUser, false);
  });

  test('send() response parses thread_id + reply', () {
    final result = ChatSendResult.fromJson({
      'thread_id': 'th1',
      'reply': 'Merhaba!',
      'tool_intents_pending': false,
    });
    expect(result.threadId, 'th1');
    expect(result.reply, 'Merhaba!');
    expect(result.toolIntentsPending, false);
  });
}

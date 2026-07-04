import 'package:dynops_mobile/features/chat/chat_conversation_screen.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  testWidgets('conversation screen renders a compose box and send button', (
    tester,
  ) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(
          home: ChatConversationScreen(
            threadId: null,
            resourceKey: 'ai_executive_assistant',
            resourceName: 'Executive Assistant',
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byType(TextField), findsOneWidget);
    expect(find.byIcon(Icons.send), findsOneWidget);
  });

  testWidgets('conversation screen renders a TTS toggle', (tester) async {
    await tester.pumpWidget(
      const ProviderScope(
        child: MaterialApp(
          home: ChatConversationScreen(
            threadId: null,
            resourceKey: 'ai_executive_assistant',
            resourceName: 'Executive Assistant',
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.byIcon(Icons.volume_off), findsOneWidget);
  });
}

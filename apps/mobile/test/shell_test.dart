import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/shell.dart';

void main() {
  testWidgets('shell renders 5 tabs', (tester) async {
    await tester.pumpWidget(MaterialApp(home: AppShell(currentPath: '/approvals', onTab: (_) {}, child: const SizedBox())));
    for (final label in ['Onaylar', 'Gelen Kutusu', 'Sohbet', 'Missionlar', 'Daha']) {
      expect(find.text(label), findsOneWidget);
    }
  });
}

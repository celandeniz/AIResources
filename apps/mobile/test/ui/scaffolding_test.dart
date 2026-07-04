import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/core/theme.dart';
import 'package:dynops_mobile/ui/components/components.dart';

void main() {
  Widget wrap(Widget child) => MaterialApp(theme: buildTheme(brightness: Brightness.dark), home: Scaffold(body: child));

  testWidgets('EmptyState shows title and icon', (tester) async {
    await tester.pumpWidget(wrap(const EmptyState(icon: Icons.check_circle, title: 'Bekleyen onay yok')));
    expect(find.text('Bekleyen onay yok'), findsOneWidget);
    expect(find.byIcon(Icons.check_circle), findsOneWidget);
  });

  testWidgets('SectionTitle uppercases text', (tester) async {
    await tester.pumpWidget(wrap(const SectionTitle('X')));
    expect(find.text('X'), findsOneWidget);
  });

  testWidgets('Skeleton builds and animates', (tester) async {
    await tester.pumpWidget(wrap(const Skeleton(width: 100, height: 20)));
    expect(find.byType(Skeleton), findsOneWidget);
    await tester.pump(const Duration(milliseconds: 80));
  });
}

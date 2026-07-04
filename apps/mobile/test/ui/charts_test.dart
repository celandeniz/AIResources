import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/core/theme.dart';
import 'package:dynops_mobile/ui/charts/charts.dart';
import 'package:dynops_mobile/ui/tokens/tokens.dart';

void main() {
  Widget wrap(Widget child) => MaterialApp(theme: buildTheme(brightness: Brightness.dark), home: Scaffold(body: child));

  testWidgets('KpiCard renders label and value', (tester) async {
    await tester.pumpWidget(wrap(const KpiCard(label: 'Onaylar', value: '185')));
    expect(find.text('ONAYLAR'), findsOneWidget);
    expect(find.text('185'), findsOneWidget);
  });

  testWidgets('DonutChart renders center label', (tester) async {
    final c = darkColors();
    await tester.pumpWidget(wrap(DonutChart(
      centerLabel: '42',
      data: [
        (name: 'AI', value: 32, color: c.primary),
        (name: 'İnsan', value: 10, color: c.success),
      ],
    )));
    expect(find.text('42'), findsOneWidget);
    expect(find.text('AI'), findsOneWidget);
  });
}

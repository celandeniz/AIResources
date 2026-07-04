import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/core/theme.dart';
import 'package:dynops_mobile/ui/components/components.dart';
import 'package:dynops_mobile/ui/tokens/tokens.dart';

void main() {
  Widget wrap(Widget child) => MaterialApp(theme: buildTheme(brightness: Brightness.dark), home: Scaffold(body: child));

  testWidgets('ConfidenceDial builds percent label', (tester) async {
    await tester.pumpWidget(wrap(const ConfidenceDial(value: 0.9)));
    expect(find.text('90%'), findsOneWidget);
    expect(find.text('CONF'), findsOneWidget);
  });

  test('ConfidenceDial color thresholds match spec', () {
    final c = darkColors();
    expect(ConfidenceDial.colorFor(0.9, c), c.success);
    expect(ConfidenceDial.colorFor(0.3, c), c.danger);
    expect(ConfidenceDial.colorFor(0.6, c), c.warning);
  });
}

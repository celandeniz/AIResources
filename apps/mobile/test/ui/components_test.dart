import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/core/theme.dart';
import 'package:dynops_mobile/ui/components/components.dart';
import 'package:dynops_mobile/ui/components/theme_tokens.dart';

void main() {
  Widget wrap(Widget child) => MaterialApp(theme: buildTheme(brightness: Brightness.dark), home: Scaffold(body: child));

  testWidgets('StatusBadge maps awaiting_approval to warning with dot', (tester) async {
    await tester.pumpWidget(wrap(const StatusBadge('awaiting_approval')));
    expect(find.text('awaiting approval'), findsOneWidget);
    expect(find.byKey(const ValueKey('dyn-badge-dot')), findsOneWidget);
    expect(StatusBadge.statusVariant('awaiting_approval'), DynBadgeVariant.warning);
  });

  testWidgets('DynButton outline has a border', (tester) async {
    await tester.pumpWidget(wrap(DynButton(variant: DynButtonVariant.outline, onPressed: () {}, child: const Text('A'))));
    final containers = tester.widgetList<AnimatedContainer>(find.byType(AnimatedContainer));
    expect(containers.any((w) => (w.decoration as BoxDecoration?)?.border != null), true);
  });

  testWidgets('ChannelChip email shows mail icon', (tester) async {
    await tester.pumpWidget(wrap(const ChannelChip('email')));
    expect(find.byIcon(Icons.mail_outline), findsOneWidget);
    expect(find.text('email'), findsOneWidget);
    expect(dynColorsFor(tester.element(find.byType(ChannelChip))).primary, isA<Color>());
  });
}

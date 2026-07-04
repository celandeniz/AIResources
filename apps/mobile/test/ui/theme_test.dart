import 'dart:ui';

import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';
import 'package:dynops_mobile/core/theme.dart';
import 'package:dynops_mobile/ui/tokens/tokens.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  GoogleFonts.config.allowRuntimeFetching = false;

  test('theme primary derives from dark token', () {
    final theme = buildTheme(brightness: Brightness.dark);
    expect(theme.colorScheme.primary, darkColors().primary);
  });

  test('kpi type enables tabular figures', () {
    final style = DynType.kpi(darkColors());
    expect(style.fontFeatures, contains(const FontFeature.tabularFigures()));
  });
}

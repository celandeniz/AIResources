import 'package:flutter_test/flutter_test.dart';
import 'package:dynops_mobile/ui/tokens/tokens.dart';

void main() {
  test('design colors use exact hsl tokens and white-label accent', () {
    expect(darkColors().primary, dynHsl(252, 83, 68));
    expect(darkColors(brandH: 200).primary, dynHsl(200, 83, 68));
    expect(darkColors(brandH: 200).primary, isNot(darkColors().primary));
    expect(lightColors().bg, isNot(darkColors().bg));
  });
}

import 'package:flutter/material.dart';

import '../tokens/tokens.dart';

DynColors dynColorsFor(BuildContext context) {
  final theme = Theme.of(context);
  final base = theme.brightness == Brightness.dark ? darkColors() : lightColors();
  final primary = theme.colorScheme.primary;
  return DynColors(
    bg: base.bg,
    fg: base.fg,
    card: base.card,
    cardFg: base.cardFg,
    muted: base.muted,
    mutedFg: base.mutedFg,
    accent: base.accent,
    accentFg: base.accentFg,
    primary: primary,
    primaryFg: theme.colorScheme.onPrimary,
    success: base.success,
    warning: base.warning,
    danger: base.danger,
    border: base.border,
    input: base.input,
    ring: primary,
    shadow: base.shadow,
  );
}

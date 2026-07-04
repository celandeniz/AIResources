import 'package:flutter/material.dart';

Color dynHsl(double h, double s, double l, [double a = 1]) =>
    HSLColor.fromAHSL(a, h, s / 100, l / 100).toColor();

class DynColors {
  const DynColors({
    required this.bg,
    required this.fg,
    required this.card,
    required this.cardFg,
    required this.muted,
    required this.mutedFg,
    required this.accent,
    required this.accentFg,
    required this.primary,
    required this.primaryFg,
    required this.success,
    required this.warning,
    required this.danger,
    required this.border,
    required this.input,
    required this.ring,
    required this.shadow,
  });

  final Color bg;
  final Color fg;
  final Color card;
  final Color cardFg;
  final Color muted;
  final Color mutedFg;
  final Color accent;
  final Color accentFg;
  final Color primary;
  final Color primaryFg;
  final Color success;
  final Color warning;
  final Color danger;
  final Color border;
  final Color input;
  final Color ring;
  final Color shadow;
}

DynColors darkColors({double brandH = 252, double brandS = 83}) {
  final primary = dynHsl(brandH, brandS, 68);
  return DynColors(
    bg: dynHsl(233, 22, 7.5),
    fg: dynHsl(233, 18, 92),
    card: dynHsl(233, 19, 10.5),
    cardFg: dynHsl(233, 18, 92),
    muted: dynHsl(233, 15, 16),
    mutedFg: dynHsl(233, 12, 62),
    accent: dynHsl(252, 40, 20),
    accentFg: dynHsl(252, 80, 86),
    primary: primary,
    primaryFg: dynHsl(233, 40, 8),
    success: dynHsl(152, 52, 46),
    warning: dynHsl(36, 94, 56),
    danger: dynHsl(0, 74, 62),
    border: dynHsl(233, 14, 19),
    input: dynHsl(233, 14, 21),
    ring: primary,
    shadow: dynHsl(233, 60, 2),
  );
}

DynColors lightColors({double brandH = 252, double brandS = 83}) {
  final primary = dynHsl(brandH, brandS, 60);
  return DynColors(
    bg: dynHsl(40, 33, 98.5),
    fg: dynHsl(233, 27, 11),
    card: dynHsl(0, 0, 100),
    cardFg: dynHsl(233, 27, 11),
    muted: dynHsl(240, 22, 95.5),
    mutedFg: dynHsl(233, 11, 44),
    accent: dynHsl(252, 70, 96),
    accentFg: dynHsl(252, 60, 36),
    primary: primary,
    primaryFg: dynHsl(0, 0, 100),
    success: dynHsl(152, 56, 38),
    warning: dynHsl(33, 92, 48),
    danger: dynHsl(0, 72, 55),
    border: dynHsl(240, 20, 89),
    input: dynHsl(240, 20, 89),
    ring: primary,
    shadow: dynHsl(233, 40, 30),
  );
}

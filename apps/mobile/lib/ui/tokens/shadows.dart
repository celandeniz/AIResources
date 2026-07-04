import 'package:flutter/material.dart';

import 'colors.dart';

class DynShadows {
  const DynShadows._();

  static List<BoxShadow> xs(DynColors c) => [
        BoxShadow(color: c.shadow.withValues(alpha: 0.04), offset: const Offset(0, 1), blurRadius: 2),
      ];

  static List<BoxShadow> sm(DynColors c) => [
        BoxShadow(color: c.shadow.withValues(alpha: 0.06), offset: const Offset(0, 1), blurRadius: 3),
        BoxShadow(color: c.shadow.withValues(alpha: 0.05), offset: const Offset(0, 1), blurRadius: 2, spreadRadius: -1),
      ];

  static List<BoxShadow> md(DynColors c) => [
        BoxShadow(color: c.shadow.withValues(alpha: 0.08), offset: const Offset(0, 4), blurRadius: 12, spreadRadius: -2),
        BoxShadow(color: c.shadow.withValues(alpha: 0.05), offset: const Offset(0, 2), blurRadius: 6, spreadRadius: -2),
      ];

  static List<BoxShadow> lg(DynColors c) => [
        BoxShadow(color: c.shadow.withValues(alpha: 0.14), offset: const Offset(0, 12), blurRadius: 32, spreadRadius: -8),
        BoxShadow(color: c.shadow.withValues(alpha: 0.06), offset: const Offset(0, 4), blurRadius: 12, spreadRadius: -4),
      ];

  static List<BoxShadow> glow(DynColors c) => [
        BoxShadow(color: c.primary.withValues(alpha: 0.18), spreadRadius: 1),
        BoxShadow(color: c.primary.withValues(alpha: 0.28), offset: const Offset(0, 8), blurRadius: 28, spreadRadius: -6),
      ];
}

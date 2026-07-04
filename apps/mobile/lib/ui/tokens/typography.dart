import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import 'colors.dart';

class DynType {
  const DynType._();

  static TextStyle pageTitle(DynColors c) => GoogleFonts.fraunces(
        color: c.fg,
        fontSize: 24,
        fontWeight: FontWeight.w600,
        height: 1.08,
      );

  static TextStyle kpi(DynColors c) => GoogleFonts.fraunces(
        color: c.fg,
        fontSize: 30,
        fontWeight: FontWeight.w600,
        height: 1,
        fontFeatures: const [FontFeature.tabularFigures()],
      );

  static TextStyle cardTitle(DynColors c) => TextStyle(
        color: c.fg,
        fontFamily: 'Geist Sans',
        fontSize: 16,
        fontWeight: FontWeight.w600,
        height: 1.2,
      );

  static TextStyle sectionTitle(DynColors c) => TextStyle(
        color: c.mutedFg,
        fontFamily: 'Geist Sans',
        fontSize: 11,
        fontWeight: FontWeight.w600,
        height: 1.2,
        letterSpacing: 1.54,
      );

  static TextStyle body(DynColors c) => TextStyle(
        color: c.fg,
        fontFamily: 'Geist Sans',
        fontSize: 14,
        fontWeight: FontWeight.w400,
        height: 1.45,
      );

  static TextStyle bodyMuted(DynColors c) => body(c).copyWith(color: c.mutedFg);

  static TextStyle mono(DynColors c) => TextStyle(
        color: c.fg,
        fontFamily: 'Geist Mono',
        fontSize: 13,
        fontWeight: FontWeight.w500,
        height: 1.35,
        fontFeatures: const [FontFeature.tabularFigures()],
      );
}

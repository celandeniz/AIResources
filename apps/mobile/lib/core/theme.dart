import 'package:flutter/material.dart';
import '../ui/tokens/tokens.dart';

ThemeData buildTheme({
  required Brightness brightness,
  double brandH = 252,
  double brandS = 83,
}) {
  final c = brightness == Brightness.dark
      ? darkColors(brandH: brandH, brandS: brandS)
      : lightColors(brandH: brandH, brandS: brandS);
  final isDark = brightness == Brightness.dark;
  final textTheme = TextTheme(
    displaySmall: DynType.pageTitle(c),
    headlineMedium: DynType.pageTitle(c),
    titleLarge: DynType.cardTitle(c).copyWith(fontSize: 20),
    titleMedium: DynType.cardTitle(c),
    bodyLarge: DynType.body(c).copyWith(fontSize: 16),
    bodyMedium: DynType.body(c),
    bodySmall: DynType.bodyMuted(c).copyWith(fontSize: 12),
    labelLarge: DynType.body(c).copyWith(fontWeight: FontWeight.w600),
    labelMedium: DynType.sectionTitle(c),
  );

  return ThemeData(
    useMaterial3: true,
    brightness: brightness,
    scaffoldBackgroundColor: c.bg,
    fontFamily: 'Geist Sans',
    colorScheme: ColorScheme(
      brightness: brightness,
      primary: c.primary,
      onPrimary: c.primaryFg,
      secondary: c.accent,
      onSecondary: c.accentFg,
      error: c.danger,
      onError: isDark ? c.fg : Colors.white,
      surface: c.bg,
      onSurface: c.fg,
    ),
    textTheme: textTheme,
    appBarTheme: AppBarTheme(
      backgroundColor: Colors.transparent,
      elevation: 0,
      centerTitle: false,
      foregroundColor: c.fg,
      titleTextStyle: DynType.pageTitle(c).copyWith(fontSize: 20),
    ),
    cardTheme: CardThemeData(
      color: c.card,
      elevation: 0,
      margin: EdgeInsets.zero,
      shape: RoundedRectangleBorder(
        borderRadius: DynRadii.cardRadius,
        side: BorderSide(color: c.border),
      ),
    ),
    chipTheme: ChipThemeData(
      backgroundColor: c.muted.withValues(alpha: 0.6),
      selectedColor: c.primary.withValues(alpha: 0.16),
      disabledColor: c.muted.withValues(alpha: 0.35),
      labelStyle: DynType.body(c).copyWith(fontSize: 12),
      secondaryLabelStyle: DynType.body(c).copyWith(color: c.primary, fontSize: 12),
      side: BorderSide(color: c.border),
      shape: RoundedRectangleBorder(borderRadius: DynRadii.full),
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
    ),
    inputDecorationTheme: InputDecorationTheme(
      filled: true,
      fillColor: c.input.withValues(alpha: isDark ? 0.72 : 0.52),
      labelStyle: DynType.bodyMuted(c),
      hintStyle: DynType.bodyMuted(c),
      border: OutlineInputBorder(borderRadius: DynRadii.mdRadius, borderSide: BorderSide(color: c.border)),
      enabledBorder: OutlineInputBorder(borderRadius: DynRadii.mdRadius, borderSide: BorderSide(color: c.border)),
      focusedBorder: OutlineInputBorder(borderRadius: DynRadii.mdRadius, borderSide: BorderSide(color: c.ring, width: 1.4)),
    ),
    navigationBarTheme: NavigationBarThemeData(
      backgroundColor: c.card.withValues(alpha: 0.96),
      indicatorColor: c.primary.withValues(alpha: 0.12),
      labelTextStyle: WidgetStateProperty.resolveWith((states) {
        final selected = states.contains(WidgetState.selected);
        return DynType.body(c).copyWith(
          color: selected ? c.primary : c.mutedFg,
          fontSize: 11,
          fontWeight: selected ? FontWeight.w600 : FontWeight.w500,
        );
      }),
      iconTheme: WidgetStateProperty.resolveWith((states) {
        final selected = states.contains(WidgetState.selected);
        return IconThemeData(color: selected ? c.primary : c.mutedFg, size: 22);
      }),
    ),
    dividerTheme: DividerThemeData(color: c.border),
    bottomAppBarTheme: BottomAppBarThemeData(color: c.card, elevation: 0),
    filledButtonTheme: FilledButtonThemeData(
      style: FilledButton.styleFrom(
        backgroundColor: c.primary,
        foregroundColor: c.primaryFg,
        shape: RoundedRectangleBorder(borderRadius: DynRadii.mdRadius),
        textStyle: DynType.body(c).copyWith(fontWeight: FontWeight.w600),
      ),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: OutlinedButton.styleFrom(
        foregroundColor: c.fg,
        side: BorderSide(color: c.border),
        shape: RoundedRectangleBorder(borderRadius: DynRadii.mdRadius),
        textStyle: DynType.body(c).copyWith(fontWeight: FontWeight.w600),
      ),
    ),
  );
}

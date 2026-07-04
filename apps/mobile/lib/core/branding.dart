import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

final themeModeProvider = StateProvider<ThemeMode>((_) => ThemeMode.dark);
final brandingProvider = StateProvider<({double h, double s})>((_) => (h: 252, s: 83));

void applyWorkspaceBranding(Ref ref, Map<String, dynamic>? workspace) {
  final branding = (workspace?['branding'] as Map?)?.cast<String, dynamic>();
  final hue = _asDouble(branding?['accent_hue'] ?? workspace?['accent_hue']);
  final sat = _asDouble(branding?['accent_sat'] ?? workspace?['accent_sat']);
  ref.read(brandingProvider.notifier).state = (h: hue ?? 252, s: sat ?? 83);
}

double? _asDouble(Object? value) {
  if (value is num) return value.toDouble();
  if (value is String) return double.tryParse(value);
  return null;
}

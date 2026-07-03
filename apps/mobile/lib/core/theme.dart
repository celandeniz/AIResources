import 'package:flutter/material.dart';

// Mirrors the web's premium DynOps system: indigo→violet accent, dark-first.
final dynopsTheme = ThemeData(
  useMaterial3: true,
  brightness: Brightness.dark,
  colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6D5DF6), brightness: Brightness.dark),
  appBarTheme: const AppBarTheme(centerTitle: false),
);

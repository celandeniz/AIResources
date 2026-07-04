import 'package:flutter/material.dart';

class DynRadii {
  const DynRadii._();

  static const double card = 13.6;
  static const double md = 9.6;
  static const double sm = 5.6;

  static BorderRadius get cardRadius => BorderRadius.circular(card);
  static BorderRadius get mdRadius => BorderRadius.circular(md);
  static BorderRadius get smRadius => BorderRadius.circular(sm);
  static BorderRadius get full => BorderRadius.circular(999);
}

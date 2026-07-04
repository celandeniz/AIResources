import 'package:flutter/animation.dart';

class DynMotion {
  const DynMotion._();

  static const easeOut = Cubic(0.23, 1, 0.32, 1);
  static const easeInOut = Cubic(0.77, 0, 0.175, 1);
  static const easeDrawer = Cubic(0.32, 0.72, 0, 1);
  static const dBtn = Duration(milliseconds: 150);
  static const dPage = Duration(milliseconds: 240);
  static const dDial = Duration(milliseconds: 600);
  static const dShimmer = Duration(milliseconds: 1600);
}

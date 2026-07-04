import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../tokens/tokens.dart';
import 'theme_tokens.dart';

class ConfidenceDial extends StatefulWidget {
  const ConfidenceDial({super.key, required this.value, this.size = 64});

  final double value;
  final double size;

  static Color colorFor(double v, DynColors c) {
    if (v < 0.5) return c.danger;
    if (v < 0.72) return c.warning;
    return c.success;
  }

  @override
  State<ConfidenceDial> createState() => _ConfidenceDialState();
}

class _ConfidenceDialState extends State<ConfidenceDial> with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late Animation<double> _value;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: DynMotion.dDial);
    _value = CurvedAnimation(parent: _controller, curve: DynMotion.easeOut)
        .drive(Tween(begin: 0, end: widget.value.clamp(0, 1).toDouble()));
    _controller.forward();
  }

  @override
  void didUpdateWidget(covariant ConfidenceDial oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.value != widget.value) {
      _value = CurvedAnimation(parent: _controller, curve: DynMotion.easeOut)
          .drive(Tween(begin: _value.value, end: widget.value.clamp(0, 1).toDouble()));
      _controller.forward(from: 0);
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    final target = widget.value.clamp(0, 1).toDouble();
    return SizedBox.square(
      dimension: widget.size,
      child: AnimatedBuilder(
        animation: _value,
        builder: (context, _) => CustomPaint(
          painter: _ConfidencePainter(value: _value.value, colors: c, target: target),
          child: Center(
            child: Column(mainAxisSize: MainAxisSize.min, children: [
              Text('${(target * 100).round()}%', style: DynType.mono(c).copyWith(fontSize: widget.size * 0.2, fontWeight: FontWeight.w600)),
              Text('CONF', style: DynType.sectionTitle(c).copyWith(fontSize: widget.size * 0.105, letterSpacing: 0.8)),
            ]),
          ),
        ),
      ),
    );
  }
}

class _ConfidencePainter extends CustomPainter {
  const _ConfidencePainter({required this.value, required this.colors, required this.target});

  final double value;
  final double target;
  final DynColors colors;

  @override
  void paint(Canvas canvas, Size size) {
    const stroke = 4.0;
    final rect = Offset.zero & size;
    final arcRect = rect.deflate(stroke / 2);
    final bg = Paint()
      ..color = colors.muted
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;
    final fg = Paint()
      ..color = ConfidenceDial.colorFor(target, colors)
      ..style = PaintingStyle.stroke
      ..strokeWidth = stroke
      ..strokeCap = StrokeCap.round;

    canvas.drawArc(arcRect, -math.pi / 2, math.pi * 2, false, bg);
    canvas.drawArc(arcRect, -math.pi / 2, math.pi * 2 * value.clamp(0, 1), false, fg);
  }

  @override
  bool shouldRepaint(covariant _ConfidencePainter oldDelegate) =>
      oldDelegate.value != value || oldDelegate.target != target || oldDelegate.colors != colors;
}

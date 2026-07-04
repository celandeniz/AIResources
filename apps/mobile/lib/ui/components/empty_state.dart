import 'package:flutter/material.dart';

import '../tokens/tokens.dart';
import 'theme_tokens.dart';

class EmptyState extends StatelessWidget {
  const EmptyState({
    super.key,
    required this.icon,
    required this.title,
    this.hint,
    this.action,
  });

  final IconData icon;
  final String title;
  final String? hint;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    return CustomPaint(
      painter: _DashedBorderPainter(color: c.border, radius: DynRadii.card),
      child: Container(
        width: double.infinity,
        padding: const EdgeInsets.symmetric(horizontal: 24, vertical: 64),
        decoration: BoxDecoration(color: c.card.withValues(alpha: 0.42), borderRadius: DynRadii.cardRadius),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Container(
            width: 54,
            height: 54,
            decoration: BoxDecoration(
              color: c.muted.withValues(alpha: 0.55),
              borderRadius: DynRadii.cardRadius,
              border: Border.all(color: c.border),
            ),
            child: Icon(icon, color: c.mutedFg, size: 25),
          ),
          const SizedBox(height: 18),
          Text(title, style: DynType.cardTitle(c), textAlign: TextAlign.center),
          if (hint != null) ...[
            const SizedBox(height: 8),
            Text(hint!, style: DynType.bodyMuted(c), textAlign: TextAlign.center),
          ],
          if (action != null) ...[
            const SizedBox(height: 18),
            action!,
          ],
        ]),
      ),
    );
  }
}

class _DashedBorderPainter extends CustomPainter {
  const _DashedBorderPainter({required this.color, required this.radius});

  final Color color;
  final double radius;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1;
    final path = Path()
      ..addRRect(RRect.fromRectAndRadius(Offset.zero & size, Radius.circular(radius)));
    for (final metric in path.computeMetrics()) {
      var distance = 0.0;
      while (distance < metric.length) {
        final next = (distance + 7).clamp(0.0, metric.length);
        canvas.drawPath(metric.extractPath(distance, next), paint);
        distance += 12;
      }
    }
  }

  @override
  bool shouldRepaint(covariant _DashedBorderPainter oldDelegate) =>
      oldDelegate.color != color || oldDelegate.radius != radius;
}

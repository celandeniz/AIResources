import 'package:flutter/material.dart';

import '../tokens/tokens.dart';
import 'theme_tokens.dart';

enum DynBadgeVariant { primary, neutral, success, warning, danger, outline }

class DynBadge extends StatelessWidget {
  const DynBadge({
    super.key,
    this.variant = DynBadgeVariant.primary,
    required this.child,
    this.leadingDot = false,
  });

  final DynBadgeVariant variant;
  final Widget child;
  final bool leadingDot;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    final color = variantColor(variant, c);
    final outlined = variant == DynBadgeVariant.outline;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: outlined ? Colors.transparent : color.withValues(alpha: 0.13),
        borderRadius: DynRadii.full,
        border: Border.all(color: outlined ? c.border : color.withValues(alpha: 0.24)),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (leadingDot) ...[
          Container(
            key: const ValueKey('dyn-badge-dot'),
            width: 6,
            height: 6,
            decoration: BoxDecoration(color: color, shape: BoxShape.circle),
          ),
          const SizedBox(width: 6),
        ],
        DefaultTextStyle.merge(
          style: DynType.body(c).copyWith(color: outlined ? c.fg : color, fontSize: 12, fontWeight: FontWeight.w600),
          child: child,
        ),
      ]),
    );
  }

  static Color variantColor(DynBadgeVariant variant, DynColors c) => switch (variant) {
        DynBadgeVariant.primary => c.primary,
        DynBadgeVariant.neutral => c.mutedFg,
        DynBadgeVariant.success => c.success,
        DynBadgeVariant.warning => c.warning,
        DynBadgeVariant.danger => c.danger,
        DynBadgeVariant.outline => c.fg,
      };
}

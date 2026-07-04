import 'package:flutter/material.dart';

import '../tokens/tokens.dart';
import 'theme_tokens.dart';

class DynCard extends StatelessWidget {
  const DynCard({
    super.key,
    required this.child,
    this.padding = 20,
    this.glow = false,
    this.onTap,
  });

  final Widget child;
  final double padding;
  final bool glow;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    final content = Container(
      padding: EdgeInsets.all(padding),
      decoration: BoxDecoration(
        color: c.card,
        borderRadius: DynRadii.cardRadius,
        border: Border.all(color: c.border),
        boxShadow: glow ? DynShadows.glow(c) : DynShadows.xs(c),
      ),
      child: child,
    );
    if (onTap == null) return content;
    return Material(
      color: Colors.transparent,
      child: InkWell(borderRadius: DynRadii.cardRadius, onTap: onTap, child: content),
    );
  }
}

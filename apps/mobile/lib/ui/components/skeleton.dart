import 'package:flutter/material.dart';

import '../tokens/tokens.dart';
import 'theme_tokens.dart';

class Skeleton extends StatefulWidget {
  const Skeleton({super.key, this.width, this.height, this.radius});

  final double? width;
  final double? height;
  final BorderRadius? radius;

  @override
  State<Skeleton> createState() => _SkeletonState();
}

class _SkeletonState extends State<Skeleton> with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(vsync: this, duration: DynMotion.dShimmer)..repeat();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    final radius = widget.radius ?? DynRadii.cardRadius;
    return AnimatedBuilder(
      animation: _controller,
      builder: (context, _) {
        final x = _controller.value * 2.4 - 1.2;
        return ShaderMask(
          blendMode: BlendMode.srcATop,
          shaderCallback: (rect) => LinearGradient(
            begin: Alignment(x - 1, 0),
            end: Alignment(x + 1, 0),
            colors: [
              c.muted.withValues(alpha: 0.46),
              c.fg.withValues(alpha: 0.08),
              c.muted.withValues(alpha: 0.46),
            ],
            stops: const [0.18, 0.5, 0.82],
          ).createShader(rect),
          child: Container(
            width: widget.width,
            height: widget.height ?? 16,
            decoration: BoxDecoration(
              color: c.muted.withValues(alpha: 0.7),
              borderRadius: radius,
            ),
          ),
        );
      },
    );
  }
}

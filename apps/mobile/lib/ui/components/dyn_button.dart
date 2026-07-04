import 'package:flutter/material.dart';

import '../tokens/tokens.dart';
import 'theme_tokens.dart';

enum DynButtonVariant { primary, secondary, outline, ghost, danger, success }
enum DynButtonSize { sm, md, lg, icon }

class DynButton extends StatefulWidget {
  const DynButton({
    super.key,
    this.variant = DynButtonVariant.primary,
    this.size = DynButtonSize.md,
    required this.onPressed,
    required this.child,
  });

  final DynButtonVariant variant;
  final DynButtonSize size;
  final VoidCallback? onPressed;
  final Widget child;

  @override
  State<DynButton> createState() => _DynButtonState();
}

class _DynButtonState extends State<DynButton> {
  bool _pressed = false;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    final enabled = widget.onPressed != null;
    final colors = _colors(c);
    final radius = widget.size == DynButtonSize.lg ? DynRadii.cardRadius : DynRadii.mdRadius;
    final padding = switch (widget.size) {
      DynButtonSize.sm => const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      DynButtonSize.md => const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
      DynButtonSize.lg => const EdgeInsets.symmetric(horizontal: 18, vertical: 14),
      DynButtonSize.icon => const EdgeInsets.all(10),
    };
    final minSize = widget.size == DynButtonSize.icon ? const Size.square(40) : const Size(0, 40);

    return GestureDetector(
      onTapDown: enabled ? (_) => setState(() => _pressed = true) : null,
      onTapCancel: enabled ? () => setState(() => _pressed = false) : null,
      onTapUp: enabled
          ? (_) {
              setState(() => _pressed = false);
              widget.onPressed?.call();
            }
          : null,
      child: AnimatedScale(
        scale: _pressed ? 0.98 : 1,
        duration: DynMotion.dBtn,
        curve: DynMotion.easeOut,
        child: AnimatedContainer(
          duration: DynMotion.dBtn,
          curve: DynMotion.easeOut,
          constraints: BoxConstraints(minHeight: minSize.height, minWidth: minSize.width),
          padding: padding,
          decoration: BoxDecoration(
            color: enabled ? colors.$1 : c.muted.withValues(alpha: 0.4),
            borderRadius: radius,
            border: colors.$3 != null ? Border.all(color: colors.$3!) : null,
            boxShadow: _pressed && widget.variant == DynButtonVariant.primary ? DynShadows.glow(c) : null,
          ),
          child: IconTheme.merge(
            data: IconThemeData(color: enabled ? colors.$2 : c.mutedFg, size: 18),
            child: DefaultTextStyle.merge(
              style: DynType.body(c).copyWith(
                color: enabled ? colors.$2 : c.mutedFg,
                fontWeight: FontWeight.w600,
              ),
              textAlign: TextAlign.center,
              child: widget.child,
            ),
          ),
        ),
      ),
    );
  }

  (Color, Color, Color?) _colors(DynColors c) => switch (widget.variant) {
        DynButtonVariant.primary => (c.primary, c.primaryFg, null),
        DynButtonVariant.secondary => (c.accent, c.accentFg, null),
        DynButtonVariant.outline => (c.card, c.fg, c.border),
        DynButtonVariant.ghost => (Colors.transparent, c.fg, null),
        DynButtonVariant.danger => (c.danger.withValues(alpha: 0.16), c.danger, c.danger.withValues(alpha: 0.28)),
        DynButtonVariant.success => (c.success.withValues(alpha: 0.16), c.success, c.success.withValues(alpha: 0.28)),
      };
}

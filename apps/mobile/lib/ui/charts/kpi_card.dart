import 'dart:math' as math;

import 'package:flutter/material.dart';

import '../components/components.dart';
import '../components/theme_tokens.dart';
import '../tokens/tokens.dart';
import 'sparkline.dart';

enum DynAccent { primary, success, warning, danger }

class KpiCard extends StatelessWidget {
  const KpiCard({
    super.key,
    required this.label,
    required this.value,
    this.sub,
    this.deltaPct,
    this.spark,
    this.accent = DynAccent.primary,
    this.onTap,
  });

  final String label;
  final String value;
  final String? sub;
  final double? deltaPct;
  final List<double>? spark;
  final DynAccent accent;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    final accentColor = _accentColor(c);
    return DynCard(
      onTap: onTap,
      child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Expanded(child: Text(label.toUpperCase(), style: DynType.sectionTitle(c))),
          if (deltaPct != null) _DeltaChip(deltaPct: deltaPct!, color: deltaPct! >= 0 ? c.success : c.danger),
        ]),
        const SizedBox(height: 12),
        Text(value, style: DynType.kpi(c)),
        if (sub != null) ...[
          const SizedBox(height: 6),
          Text(sub!, style: DynType.bodyMuted(c).copyWith(fontSize: 12)),
        ],
        if (spark != null) ...[
          const SizedBox(height: 14),
          SizedBox(height: 40, child: Sparkline(spark!, accentColor)),
        ],
      ]),
    );
  }

  Color _accentColor(DynColors c) => switch (accent) {
        DynAccent.primary => c.primary,
        DynAccent.success => c.success,
        DynAccent.warning => c.warning,
        DynAccent.danger => c.danger,
      };
}

class _DeltaChip extends StatelessWidget {
  const _DeltaChip({required this.deltaPct, required this.color});

  final double deltaPct;
  final Color color;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    final up = deltaPct >= 0;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 4),
      decoration: BoxDecoration(color: color.withValues(alpha: 0.13), borderRadius: DynRadii.full),
      child: Text(
        '${up ? '▲' : '▼'} ${deltaPct.abs().toStringAsFixed(math.max(0, deltaPct.abs()) >= 10 ? 0 : 1)}%',
        style: DynType.mono(c).copyWith(color: color, fontSize: 11, fontWeight: FontWeight.w600),
      ),
    );
  }
}

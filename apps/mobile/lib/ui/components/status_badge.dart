import 'package:flutter/material.dart';

import 'dyn_badge.dart';

class StatusBadge extends StatelessWidget {
  const StatusBadge(this.status, {super.key});

  final String status;

  @override
  Widget build(BuildContext context) => DynBadge(
        variant: statusVariant(status),
        leadingDot: true,
        child: Text(_label(status)),
      );

  static DynBadgeVariant statusVariant(String status) {
    final s = status.toLowerCase();
    if (const ['triaging', 'routed', 'in_progress'].contains(s)) return DynBadgeVariant.primary;
    if (const ['awaiting_approval', 'pending'].contains(s)) return DynBadgeVariant.warning;
    if (const ['escalated', 'failed', 'rejected'].contains(s)) return DynBadgeVariant.danger;
    if (const ['completed', 'approved', 'succeeded'].contains(s)) return DynBadgeVariant.success;
    return DynBadgeVariant.neutral;
  }

  static String _label(String status) => status.replaceAll('_', ' ');
}

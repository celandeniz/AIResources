import 'package:flutter/material.dart';

import '../tokens/tokens.dart';
import 'theme_tokens.dart';

class ChannelChip extends StatelessWidget {
  const ChannelChip(this.channel, {super.key});

  final String channel;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    final icon = iconFor(channel);
    final label = channel.isEmpty ? '?' : channel;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 5),
      decoration: BoxDecoration(
        color: c.muted.withValues(alpha: 0.4),
        borderRadius: DynRadii.smRadius,
        border: Border.all(color: c.border),
      ),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        Icon(icon, size: 12, color: c.mutedFg),
        const SizedBox(width: 6),
        Text(label, style: DynType.body(c).copyWith(fontSize: 12, color: c.mutedFg, fontWeight: FontWeight.w600)),
      ]),
    );
  }

  static IconData iconFor(String channel) => switch (channel.toLowerCase()) {
        'email' => Icons.mail_outline,
        'teams' => Icons.groups_outlined,
        'calendar' => Icons.event_outlined,
        'devops' => Icons.bug_report_outlined,
        'github' => Icons.code_outlined,
        'whatsapp' => Icons.chat_outlined,
        'mission' => Icons.rocket_launch_outlined,
        'manual' => Icons.edit_outlined,
        _ => Icons.circle_outlined,
      };
}

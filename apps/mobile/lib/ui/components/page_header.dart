import 'package:flutter/material.dart';

import '../tokens/tokens.dart';
import 'theme_tokens.dart';

class PageHeader extends StatelessWidget {
  const PageHeader({
    super.key,
    required this.title,
    this.subtitle,
    this.actions = const [],
  });

  final String title;
  final String? subtitle;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    return Padding(
      padding: const EdgeInsets.only(bottom: 24),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: DynType.pageTitle(c)),
            if (subtitle != null) ...[
              const SizedBox(height: 6),
              Text(subtitle!, style: DynType.bodyMuted(c)),
            ],
          ]),
        ),
        if (actions.isNotEmpty) ...[
          const SizedBox(width: 12),
          Wrap(spacing: 8, runSpacing: 8, alignment: WrapAlignment.end, children: actions),
        ],
      ]),
    );
  }
}

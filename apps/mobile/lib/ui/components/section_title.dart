import 'package:flutter/material.dart';

import '../tokens/tokens.dart';
import 'theme_tokens.dart';

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key, this.trailing});

  final String text;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    return Row(children: [
      Expanded(child: Text(text.toUpperCase(), style: DynType.sectionTitle(c))),
      if (trailing != null) trailing!,
    ]);
  }
}

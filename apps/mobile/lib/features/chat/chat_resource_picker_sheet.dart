import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';
import '../../ui/tokens/tokens.dart';
import 'chat_models.dart';
import 'chat_repository.dart';

Future<ChatResource?> showResourcePicker(BuildContext context, WidgetRef ref) {
  return showModalBottomSheet<ChatResource>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (_) => const _ResourcePickerSheet(),
  );
}

class _ResourcePickerSheet extends ConsumerWidget {
  const _ResourcePickerSheet();

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final resources = ref.watch(chatResourcesProvider);
    final c = dynColorsFor(context);
    return Container(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.of(context).size.height * 0.72,
      ),
      padding: const EdgeInsets.fromLTRB(20, 10, 20, 20),
      decoration: BoxDecoration(
        color: c.bg,
        borderRadius: const BorderRadius.vertical(top: Radius.circular(22)),
      ),
      child: Column(mainAxisSize: MainAxisSize.min, children: [
        Container(
          width: 38,
          height: 4,
          decoration: BoxDecoration(
            color: c.border,
            borderRadius: DynRadii.full,
          ),
        ),
        const SizedBox(height: 20),
        const PageHeader(
          title: 'Kaynak sec',
          subtitle: 'Sohbeti hangi AI kaynagiyla baslatmak istiyorsun?',
        ),
        Flexible(
          child: resources.when(
            loading: () => const Center(child: CircularProgressIndicator()),
            error: (error, _) => EmptyState(
              icon: Icons.error_outline,
              title: 'Kaynaklar yuklenemedi',
              hint: '$error',
            ),
            data: (items) => items.isEmpty
                ? const EmptyState(
                    icon: Icons.smart_toy_outlined,
                    title: 'Aktif kaynak yok',
                    hint: 'Aktif bir AI kaynagi eklendiginde burada gorunur.',
                  )
                : ListView.separated(
                    shrinkWrap: true,
                    itemCount: items.length,
                    separatorBuilder: (_, __) => const SizedBox(height: 10),
                    itemBuilder: (_, index) {
                      final resource = items[index];
                      return DynCard(
                        padding: 14,
                        onTap: () => Navigator.of(context).pop(resource),
                        child: Row(children: [
                          Container(
                            width: 42,
                            height: 42,
                            decoration: BoxDecoration(
                              color: c.primary.withValues(alpha: 0.14),
                              borderRadius: DynRadii.mdRadius,
                              border: Border.all(color: c.border),
                            ),
                            child: Icon(Icons.smart_toy_outlined, color: c.primary),
                          ),
                          const SizedBox(width: 12),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text(resource.name, style: DynType.cardTitle(c)),
                                if (resource.role != null) ...[
                                  const SizedBox(height: 4),
                                  Text(
                                    resource.role!,
                                    style: DynType.bodyMuted(c),
                                    maxLines: 1,
                                    overflow: TextOverflow.ellipsis,
                                  ),
                                ],
                              ],
                            ),
                          ),
                          Icon(Icons.chevron_right, color: c.mutedFg),
                        ]),
                      );
                    },
                  ),
          ),
        ),
      ]),
    );
  }
}

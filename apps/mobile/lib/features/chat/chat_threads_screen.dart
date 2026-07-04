import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import 'package:intl/intl.dart';

import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';
import '../../ui/tokens/tokens.dart';
import 'chat_repository.dart';
import 'chat_resource_picker_sheet.dart';

class ChatThreadsScreen extends ConsumerWidget {
  const ChatThreadsScreen({super.key});

  Future<void> _newChat(BuildContext context, WidgetRef ref) async {
    final resource = await showResourcePicker(context, ref);
    if (resource == null || !context.mounted) return;
    context.push(
      '/chat/new?resourceKey=${Uri.encodeComponent(resource.key)}&resourceName=${Uri.encodeComponent(resource.name)}',
    );
  }

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final threads = ref.watch(chatThreadsProvider);
    final c = dynColorsFor(context);
    final fmt = DateFormat('d MMM HH:mm');
    return Scaffold(
      body: SafeArea(
        child: RefreshIndicator(
          onRefresh: () async => ref.invalidate(chatThreadsProvider),
          child: CustomScrollView(slivers: [
            SliverPadding(
              padding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
              sliver: SliverToBoxAdapter(
                child: PageHeader(
                  title: 'Sohbet',
                  subtitle: 'AI kaynaklariyla devam eden konusmalar',
                  actions: [
                    DynButton(
                      size: DynButtonSize.icon,
                      onPressed: () => _newChat(context, ref),
                      child: const Icon(Icons.add_comment_outlined),
                    ),
                  ],
                ),
              ),
            ),
            threads.when(
              loading: () => const SliverFillRemaining(
                hasScrollBody: false,
                child: Center(child: CircularProgressIndicator()),
              ),
              error: (error, _) => SliverPadding(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                sliver: SliverFillRemaining(
                  hasScrollBody: false,
                  child: EmptyState(
                    icon: Icons.error_outline,
                    title: 'Sohbetler yuklenemedi',
                    hint: '$error',
                  ),
                ),
              ),
              data: (items) => items.isEmpty
                  ? SliverPadding(
                      padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                      sliver: SliverFillRemaining(
                        hasScrollBody: false,
                        child: EmptyState(
                          icon: Icons.chat_bubble_outline,
                          title: 'Henuz sohbet yok',
                          hint: 'Yeni bir sohbet baslatmak icin kaynak sec.',
                          action: DynButton(
                            onPressed: () => _newChat(context, ref),
                            child: const Row(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Icon(Icons.add_comment_outlined),
                                SizedBox(width: 8),
                                Text('Yeni sohbet'),
                              ],
                            ),
                          ),
                        ),
                      ),
                    )
                  : SliverPadding(
                      padding: const EdgeInsets.fromLTRB(20, 0, 20, 24),
                      sliver: SliverList.separated(
                        itemCount: items.length,
                        separatorBuilder: (_, __) => const SizedBox(height: 12),
                        itemBuilder: (_, index) {
                          final thread = items[index];
                          return DynCard(
                            padding: 16,
                            onTap: () => context.push(
                              '/chat/${thread.id}?resourceKey=${Uri.encodeComponent(thread.resourceKey ?? '')}&resourceName=${Uri.encodeComponent(thread.resourceName ?? 'Sohbet')}',
                            ),
                            child: Row(children: [
                              Container(
                                width: 44,
                                height: 44,
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
                                    Row(children: [
                                      Expanded(
                                        child: Text(
                                          thread.resourceName ?? thread.subject ?? 'Sohbet',
                                          style: DynType.cardTitle(c),
                                          maxLines: 1,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                      if (thread.status != null) ...[
                                        const SizedBox(width: 8),
                                        StatusBadge(thread.status!),
                                      ],
                                    ]),
                                    const SizedBox(height: 8),
                                    Text(
                                      thread.lastMessage ?? thread.subject ?? '',
                                      style: DynType.bodyMuted(c),
                                      maxLines: 2,
                                      overflow: TextOverflow.ellipsis,
                                    ),
                                    if (thread.lastMessageAt != null) ...[
                                      const SizedBox(height: 10),
                                      Text(
                                        fmt.format(thread.lastMessageAt!.toLocal()),
                                        style: DynType.mono(c).copyWith(color: c.mutedFg),
                                      ),
                                    ],
                                  ],
                                ),
                              ),
                            ]),
                          );
                        },
                      ),
                    ),
            ),
          ]),
        ),
      ),
    );
  }
}

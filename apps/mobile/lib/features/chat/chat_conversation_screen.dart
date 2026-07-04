import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_tts/flutter_tts.dart';
import 'package:speech_to_text/speech_to_text.dart' as stt;

import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';
import '../../ui/tokens/tokens.dart';
import 'chat_models.dart';
import 'chat_repository.dart';

class ChatConversationScreen extends ConsumerStatefulWidget {
  const ChatConversationScreen({
    super.key,
    required this.threadId,
    required this.resourceKey,
    required this.resourceName,
  });

  final String? threadId;
  final String resourceKey;
  final String resourceName;

  @override
  ConsumerState<ChatConversationScreen> createState() =>
      _ChatConversationScreenState();
}

class _ChatConversationScreenState extends ConsumerState<ChatConversationScreen> {
  final _composeController = TextEditingController();
  final _scrollController = ScrollController();
  final stt.SpeechToText _speech = stt.SpeechToText();
  final FlutterTts _tts = FlutterTts();
  final List<ChatMessage> _optimistic = [];
  String? _threadId;
  bool _sending = false;
  bool _speechAvailable = false;
  bool _listening = false;
  bool _ttsEnabled = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _threadId = widget.threadId;
    _initSpeech();
  }

  @override
  void dispose() {
    _speech.stop();
    _tts.stop();
    _composeController.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  Future<void> _initSpeech() async {
    try {
      _speechAvailable = await _speech.initialize(
        onStatus: (status) {
          if (!mounted) return;
          if (status == 'done' || status == 'notListening') {
            setState(() => _listening = false);
          }
        },
      );
    } catch (_) {
      _speechAvailable = false;
    }
    if (mounted) setState(() {});
  }

  Future<void> _toggleListening() async {
    if (!_speechAvailable) return;
    if (_listening) {
      await _speech.stop();
      if (mounted) setState(() => _listening = false);
      return;
    }

    setState(() => _listening = true);
    final localeId =
        Localizations.localeOf(context).languageCode == 'tr' ? 'tr_TR' : 'en_US';
    await _speech.listen(
      listenOptions: stt.SpeechListenOptions(
        localeId: localeId,
        listenMode: stt.ListenMode.dictation,
        partialResults: true,
      ),
      onResult: (result) {
        if (!mounted) return;
        setState(() {
          _composeController.text = result.recognizedWords;
          _composeController.selection = TextSelection.collapsed(
            offset: _composeController.text.length,
          );
        });
      },
    );
  }

  Future<void> _maybeSpeak(String text) async {
    if (!_ttsEnabled || text.isEmpty) return;
    try {
      final locale =
          Localizations.localeOf(context).languageCode == 'tr' ? 'tr-TR' : 'en-US';
      await _tts.setLanguage(locale);
      await _tts.speak(text);
    } catch (_) {
      // Voice output is best-effort and must never block chat.
    }
  }

  Future<void> _send() async {
    final text = _composeController.text.trim();
    if (text.isEmpty || _sending) return;
    setState(() {
      _sending = true;
      _error = null;
      _optimistic.add(ChatMessage(
        id: 'local-${DateTime.now().microsecondsSinceEpoch}',
        direction: 'inbound',
        authorType: 'user',
        body: text,
        createdAt: DateTime.now(),
      ));
    });
    _composeController.clear();

    try {
      final result = await ref.read(chatActionsProvider).send(
            resourceKey: widget.resourceKey,
            message: text,
            threadId: _threadId,
          );
      setState(() => _threadId = result.threadId);
      ref.invalidate(chatMessagesProvider(result.threadId));
      ref.invalidate(chatThreadsProvider);
      await _maybeSpeak(result.reply);
      if (result.toolIntentsPending && mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(
            content: Text('Bu istek Onaylar sekmesinde bekliyor.'),
          ),
        );
      }
    } catch (error) {
      setState(() => _error = 'Gonderilemedi: $error');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final messagesAsync =
        _threadId != null ? ref.watch(chatMessagesProvider(_threadId!)) : null;
    final c = dynColorsFor(context);

    return Scaffold(
      body: SafeArea(
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(20, 18, 20, 0),
            child: PageHeader(
              title: widget.resourceName,
              subtitle: _threadId == null ? 'Yeni sohbet' : 'Devam eden sohbet',
              actions: [
                DynButton(
                  variant: DynButtonVariant.ghost,
                  size: DynButtonSize.icon,
                  onPressed: () => setState(() => _ttsEnabled = !_ttsEnabled),
                  child: Icon(_ttsEnabled ? Icons.volume_up : Icons.volume_off),
                ),
              ],
            ),
          ),
          Expanded(
            child: messagesAsync == null
                ? _bubbleList(_optimistic)
                : messagesAsync.when(
                    loading: () => _bubbleList(_optimistic),
                    error: (error, _) => Center(
                      child: Padding(
                        padding: const EdgeInsets.all(20),
                        child: EmptyState(
                          icon: Icons.error_outline,
                          title: 'Mesajlar yuklenemedi',
                          hint: '$error',
                        ),
                      ),
                    ),
                    data: (persisted) =>
                        _bubbleList(persisted.isNotEmpty ? persisted : _optimistic),
                  ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 10),
              child: Text(_error!, style: DynType.body(c).copyWith(color: c.danger)),
            ),
          SafeArea(top: false, child: _ComposeBar(
            controller: _composeController,
            sending: _sending,
            speechAvailable: _speechAvailable,
            listening: _listening,
            onMic: _toggleListening,
            onSend: _send,
          )),
        ]),
      ),
    );
  }

  Widget _bubbleList(List<ChatMessage> items) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (_scrollController.hasClients) {
        _scrollController.jumpTo(_scrollController.position.maxScrollExtent);
      }
    });

    if (items.isEmpty) {
      return const Padding(
        padding: EdgeInsets.all(20),
        child: EmptyState(
          icon: Icons.chat_bubble_outline,
          title: 'Bir mesaj yazarak basla',
          hint: 'Yaniti bu ekranda sohbet balonu olarak goreceksin.',
        ),
      );
    }

    return ListView.separated(
      controller: _scrollController,
      padding: const EdgeInsets.fromLTRB(20, 0, 20, 18),
      itemCount: items.length,
      separatorBuilder: (_, __) => const SizedBox(height: 10),
      itemBuilder: (_, index) => _ChatBubble(message: items[index]),
    );
  }
}

class _ChatBubble extends StatelessWidget {
  const _ChatBubble({required this.message});

  final ChatMessage message;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    final isUser = message.isUser;
    return Align(
      alignment: isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: MediaQuery.of(context).size.width * 0.78,
        ),
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: isUser ? c.primary : c.card,
            borderRadius: BorderRadius.only(
              topLeft: const Radius.circular(18),
              topRight: const Radius.circular(18),
              bottomLeft: Radius.circular(isUser ? 18 : 6),
              bottomRight: Radius.circular(isUser ? 6 : 18),
            ),
            border: Border.all(color: isUser ? c.primary : c.border),
            boxShadow: isUser ? null : DynShadows.xs(c),
          ),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 11),
            child: Text(
              message.body ?? '',
              style: DynType.body(c).copyWith(
                color: isUser ? c.primaryFg : c.cardFg,
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _ComposeBar extends StatelessWidget {
  const _ComposeBar({
    required this.controller,
    required this.sending,
    required this.speechAvailable,
    required this.listening,
    required this.onMic,
    required this.onSend,
  });

  final TextEditingController controller;
  final bool sending;
  final bool speechAvailable;
  final bool listening;
  final VoidCallback onMic;
  final VoidCallback onSend;

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    return Container(
      padding: const EdgeInsets.fromLTRB(20, 12, 20, 14),
      decoration: BoxDecoration(
        color: c.bg,
        border: Border(top: BorderSide(color: c.border)),
      ),
      child: Row(crossAxisAlignment: CrossAxisAlignment.end, children: [
        Expanded(
          child: TextField(
            controller: controller,
            minLines: 1,
            maxLines: 4,
            textInputAction: TextInputAction.send,
            decoration: InputDecoration(
              hintText: 'Mesaj yaz...',
              filled: true,
              fillColor: c.input,
              border: OutlineInputBorder(
                borderRadius: DynRadii.mdRadius,
                borderSide: BorderSide(color: c.border),
              ),
              enabledBorder: OutlineInputBorder(
                borderRadius: DynRadii.mdRadius,
                borderSide: BorderSide(color: c.border),
              ),
              focusedBorder: OutlineInputBorder(
                borderRadius: DynRadii.mdRadius,
                borderSide: BorderSide(color: c.primary, width: 1.4),
              ),
            ),
            onSubmitted: (_) => onSend(),
          ),
        ),
        const SizedBox(width: 10),
        if (speechAvailable) ...[
          DynButton(
            variant: listening ? DynButtonVariant.danger : DynButtonVariant.outline,
            size: DynButtonSize.icon,
            onPressed: onMic,
            child: Icon(listening ? Icons.mic : Icons.mic_none),
          ),
          const SizedBox(width: 10),
        ],
        sending
            ? const SizedBox(
                height: 40,
                width: 40,
                child: Center(child: CircularProgressIndicator(strokeWidth: 2)),
              )
            : DynButton(
                size: DynButtonSize.icon,
                onPressed: onSend,
                child: const Icon(Icons.send),
              ),
      ]),
    );
  }
}

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:local_auth/local_auth.dart';
import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';
import '../../ui/tokens/tokens.dart';
import 'operator_channel.dart';
import 'operator_models.dart';
import 'operator_repository.dart';

const _biometricKey = 'dynops_operator_require_biometric_v1';

class OperatorDetailScreen extends ConsumerStatefulWidget {
  const OperatorDetailScreen({super.key, required this.commandId});
  final String commandId;

  @override
  ConsumerState<OperatorDetailScreen> createState() => _OperatorDetailScreenState();
}

class _OperatorDetailScreenState extends ConsumerState<OperatorDetailScreen> {
  bool _executing = false;
  List<Map<String, dynamic>> _results = const [];
  String? _error;

  @override
  Widget build(BuildContext context) {
    final commands = ref.watch(operatorCommandsProvider);
    return Scaffold(
      appBar: AppBar(title: const Text('Görev Detayı')),
      body: commands.when(
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (error, _) => Center(child: Text('Hata: $error')),
        data: (list) {
          final matches = list.where((c) => c.id == widget.commandId);
          if (matches.isEmpty) {
            return const Padding(
              padding: EdgeInsets.all(16),
              child: EmptyState(
                icon: Icons.hourglass_empty,
                title: 'Görev bulunamadı',
                hint: 'Görev süresi dolmuş veya sonuç bildirilmiş olabilir.',
              ),
            );
          }
          final command = matches.first;
          final c = dynColorsFor(context);
          return ListView(
            padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
            children: [
              PageHeader(title: command.kind, subtitle: '${command.payload.length} adım'),
              const SizedBox(height: 12),
              DynCard(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('Sunucu tarafından planlanan adımlar', style: DynType.cardTitle(c)),
                    const SizedBox(height: 12),
                    for (final indexed in command.payload.indexed)
                      ListTile(
                        contentPadding: EdgeInsets.zero,
                        dense: true,
                        leading: CircleAvatar(
                          radius: 14,
                          child: Text('${indexed.$1 + 1}'),
                        ),
                        title: Text(indexed.$2.toString()),
                      ),
                    if (_executing) ...[
                      const SizedBox(height: 12),
                      const LinearProgressIndicator(),
                      const SizedBox(height: 8),
                      Text('Görev telefonda çalışıyor', style: DynType.bodyMuted(c)),
                    ],
                    if (_error != null) ...[
                      const SizedBox(height: 12),
                      Text(_error!, style: DynType.body(c).copyWith(color: c.danger)),
                    ],
                    if (_results.isNotEmpty) ...[
                      const SizedBox(height: 16),
                      Text('Sonuç', style: DynType.cardTitle(c)),
                      const SizedBox(height: 8),
                      for (final result in _results)
                        StatusBadge(result['ok'] == true ? 'succeeded' : 'failed'),
                    ],
                    const SizedBox(height: 18),
                    DynButton(
                      onPressed: _executing ? null : () => _execute(command),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          const Icon(Icons.play_arrow),
                          const SizedBox(width: 8),
                          Text(_executing ? 'Çalışıyor' : 'Çalıştır'),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            ],
          );
        },
      ),
    );
  }

  Future<void> _execute(DeviceCommand command) async {
    setState(() {
      _executing = true;
      _results = const [];
      _error = null;
    });
    try {
      final requireBiometric = await _readBiometricSetting();
      if (requireBiometric) {
        final ok = await LocalAuthentication().authenticate(
          localizedReason: 'Telefon görevini çalıştırmak için doğrulayın',
          options: const AuthenticationOptions(biometricOnly: false),
        );
        if (!ok) {
          setState(() => _executing = false);
          return;
        }
      }

      final steps = command.payload
          .whereType<Map>()
          .map((item) => item.cast<String, dynamic>())
          .toList();
      final results = await OperatorChannel.executeSteps(steps);
      final allOk = results.isNotEmpty && results.every((result) => result['ok'] == true);
      final failed = results.where((result) => result['ok'] != true);
      await ref.read(operatorActionsProvider).postResult(
            command.id,
            succeeded: allOk,
            steps: results,
            detail: allOk || failed.isEmpty ? null : 'Failed at step ${failed.first['index']}',
          );
      ref.invalidate(operatorCommandsProvider);
      if (!mounted) return;
      setState(() {
        _results = results;
        _executing = false;
      });
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(content: Text(allOk ? 'Görev tamamlandı' : 'Görev başarısız - sunucuya bildirildi')),
      );
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _error = e.toString();
        _executing = false;
      });
    }
  }

  Future<bool> _readBiometricSetting() async {
    final value = await const FlutterSecureStorage().read(key: _biometricKey);
    return value == 'true';
  }
}

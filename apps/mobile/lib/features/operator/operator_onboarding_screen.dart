import 'package:flutter/material.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import '../../ui/components/components.dart';
import '../../ui/components/theme_tokens.dart';
import '../../ui/tokens/tokens.dart';
import 'operator_channel.dart';

const operatorConsentKey = 'dynops_operator_consent_v1';

class OperatorOnboardingScreen extends StatefulWidget {
  const OperatorOnboardingScreen({super.key, required this.onConsented});
  final VoidCallback onConsented;

  @override
  State<OperatorOnboardingScreen> createState() => _OperatorOnboardingScreenState();
}

class _OperatorOnboardingScreenState extends State<OperatorOnboardingScreen> {
  bool _accessibilityEnabled = false;
  bool _checking = true;

  @override
  void initState() {
    super.initState();
    _check();
  }

  Future<void> _check() async {
    final enabled = await OperatorChannel.isAccessibilityServiceEnabled();
    if (!mounted) return;
    setState(() {
      _accessibilityEnabled = enabled;
      _checking = false;
    });
  }

  @override
  Widget build(BuildContext context) {
    final c = dynColorsFor(context);
    return Scaffold(
      appBar: AppBar(title: const Text('Telefon Operatörü')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.fromLTRB(16, 18, 16, 28),
          children: [
            const PageHeader(
              title: 'Telefon Operatörü',
              subtitle: 'Onaylanmış görevler için yerel yürütücü',
            ),
            const SizedBox(height: 12),
            DynCard(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text('Açık onay gerekli', style: DynType.cardTitle(c)),
                  const SizedBox(height: 10),
                  Text(
                    'Bu özellik yalnızca sizin onayladığınız görevleri telefonunuzda çalıştırır. Sunucudaki AI telefonda plan yapmaz ve onaysız adım çalışmaz.',
                    style: DynType.body(c),
                  ),
                  const SizedBox(height: 18),
                  StatusBadge(_accessibilityEnabled ? 'approved' : 'pending'),
                  const SizedBox(height: 18),
                  if (_checking)
                    const Center(child: CircularProgressIndicator())
                  else ...[
                    DynButton(
                      onPressed: () async {
                        await OperatorChannel.openAccessibilitySettings();
                        await _check();
                      },
                      child: const Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(Icons.settings_accessibility),
                          SizedBox(width: 8),
                          Text('Erişilebilirlik Ayarlarını Aç'),
                        ],
                      ),
                    ),
                    const SizedBox(height: 12),
                    DynButton(
                      variant: DynButtonVariant.primary,
                      onPressed: _accessibilityEnabled
                          ? () async {
                              await const FlutterSecureStorage()
                                  .write(key: operatorConsentKey, value: 'granted');
                              widget.onConsented();
                            }
                          : null,
                      child: const Text('Onaylıyorum ve Etkinleştiriyorum'),
                    ),
                  ],
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Future<bool> hasOperatorConsent() async {
  final value = await const FlutterSecureStorage().read(key: operatorConsentKey);
  return value == 'granted';
}

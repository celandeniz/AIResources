import 'package:flutter/services.dart';

class OperatorChannel {
  static const _channel = MethodChannel('com.dynamicsops.dynops_mobile/operator');

  static Future<bool> isAccessibilityServiceEnabled() async {
    return await _channel.invokeMethod<bool>('isAccessibilityServiceEnabled') ?? false;
  }

  static Future<void> openAccessibilitySettings() async {
    await _channel.invokeMethod('openAccessibilitySettings');
  }
}

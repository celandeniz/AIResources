import 'dart:async';
import 'dart:convert';
import 'package:http/http.dart' as http;

/// Minimal EventSource: parses `event:`/`data:` lines from /api/v1/stream.
/// On error/close it calls [onDown] once — callers switch to 8s polling and
/// may call [connect] again to retry.
class SseClient {
  SseClient(this.url, {required this.onEvent, required this.onDown});
  final Uri url;
  final void Function(String event, String data) onEvent;
  final void Function() onDown;
  http.Client? _client;
  StreamSubscription<String>? _sub;

  Future<void> connect() async {
    close();
    _client = http.Client();
    try {
      final req = http.Request('GET', url)..headers['accept'] = 'text/event-stream';
      final res = await _client!.send(req);
      var event = 'message';
      _sub = res.stream.transform(utf8.decoder).transform(const LineSplitter()).listen((line) {
        if (line.startsWith('event:')) {
          event = line.substring(6).trim();
        } else if (line.startsWith('data:')) {
          onEvent(event, line.substring(5).trim());
        } else if (line.isEmpty) {
          event = 'message';
        }
      }, onError: (_) => onDown(), onDone: onDown, cancelOnError: true);
    } catch (_) {
      onDown();
    }
  }

  void close() {
    _sub?.cancel();
    _client?.close();
    _sub = null;
    _client = null;
  }
}

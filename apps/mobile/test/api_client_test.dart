import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:dynops_mobile/core/api.dart';

void main() {
  test('sends bearer + workspace headers and decodes json', () async {
    late http.Request seen;
    final mock = MockClient((req) async {
      seen = req;
      return http.Response('{"ok":true}', 200);
    });
    final api = ApiClient(baseUrl: 'http://x', client: mock)
      ..token = 'T'
      ..workspaceId = 'W';
    final res = await api.get('/approvals', query: {'status': 'pending'});
    expect(res['ok'], true);
    expect(seen.headers['authorization'], 'Bearer T');
    expect(seen.headers['x-workspace'], 'W');
    expect(seen.url.toString(), 'http://x/api/v1/approvals?status=pending');
  });

  test('401 throws ApiAuthException', () async {
    final api = ApiClient(baseUrl: 'http://x', client: MockClient((_) async => http.Response('', 401)));
    expect(() => api.get('/approvals'), throwsA(isA<ApiAuthException>()));
  });
}

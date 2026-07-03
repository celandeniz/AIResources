import 'dart:convert';
import 'package:http/http.dart' as http;

class ApiClient {
  ApiClient({required this.baseUrl, this.token, this.workspaceId, http.Client? client})
      : _client = client ?? http.Client();

  final String baseUrl; // e.g. http://localhost:4000
  String? token;
  String? workspaceId;
  final http.Client _client;

  Uri _u(String path, [Map<String, String>? q]) =>
      Uri.parse('$baseUrl/api/v1$path').replace(queryParameters: q);

  Map<String, String> get headers => {
        'content-type': 'application/json',
        if (token != null) 'authorization': 'Bearer $token',
        if (workspaceId != null) 'x-workspace': workspaceId!,
      };

  Future<dynamic> get(String path, {Map<String, String>? query}) async =>
      _decode(await _client.get(_u(path, query), headers: headers));

  Future<dynamic> post(String path, {Object? body}) async =>
      _decode(await _client.post(_u(path), headers: headers, body: jsonEncode(body ?? {})));

  Future<dynamic> delete(String path) async =>
      _decode(await _client.delete(_u(path), headers: headers));

  dynamic _decode(http.Response res) {
    if (res.statusCode == 401) throw ApiAuthException();
    if (res.statusCode >= 400) throw ApiException(res.statusCode, res.body);
    if (res.body.isEmpty) return null;
    return jsonDecode(res.body);
  }

  Uri streamUrl() => Uri.parse(
      '$baseUrl/api/v1/stream?access_token=${Uri.encodeComponent(token ?? '')}&workspace=${Uri.encodeComponent(workspaceId ?? '')}');
}

class ApiException implements Exception {
  ApiException(this.status, this.body);
  final int status;
  final String body;
  @override
  String toString() => 'API $status: $body';
}

class ApiAuthException implements Exception {}

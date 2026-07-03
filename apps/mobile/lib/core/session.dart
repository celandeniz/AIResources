import 'dart:convert';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'api.dart';

class Session {
  const Session({required this.api, required this.user});
  final ApiClient api;
  final Map<String, dynamic> user;
  String get role => (user['role'] ?? 'viewer') as String;
  bool get canDecide => role != 'viewer';
  bool get canManage => role == 'manager' || role == 'admin';
}

final sessionProvider = StateProvider<Session?>((_) => null);

class AuthRepository {
  AuthRepository(this.ref);
  final Ref ref;
  static const _storage = FlutterSecureStorage();

  Future<Session> login(String serverUrl, String email) async {
    final api = ApiClient(baseUrl: serverUrl);
    final res = await api.post('/auth/dev-login', body: {'email': email});
    api.token = res['accessToken'] as String;
    final workspaces = await api.get('/workspaces') as List;
    if (workspaces.isNotEmpty) api.workspaceId = workspaces.first['id'] as String;
    final user = (res['user'] as Map).cast<String, dynamic>();
    await _storage.write(key: 'dynops_server', value: serverUrl);
    await _storage.write(key: 'dynops_token', value: api.token);
    await _storage.write(key: 'dynops_workspace', value: api.workspaceId);
    await _storage.write(key: 'dynops_user', value: jsonEncode(user));
    final session = Session(api: api, user: user);
    ref.read(sessionProvider.notifier).state = session;
    return session;
  }

  Future<Session?> restore() async {
    final server = await _storage.read(key: 'dynops_server');
    final token = await _storage.read(key: 'dynops_token');
    if (server == null || token == null) return null;
    final api = ApiClient(baseUrl: server)
      ..token = token
      ..workspaceId = await _storage.read(key: 'dynops_workspace');
    final userRaw = await _storage.read(key: 'dynops_user');
    final user = userRaw != null ? (jsonDecode(userRaw) as Map).cast<String, dynamic>() : <String, dynamic>{};
    final session = Session(api: api, user: user);
    ref.read(sessionProvider.notifier).state = session;
    return session;
  }

  Future<void> logout() async {
    await _storage.deleteAll();
    ref.read(sessionProvider.notifier).state = null;
  }
}

final authRepositoryProvider = Provider((ref) => AuthRepository(ref));

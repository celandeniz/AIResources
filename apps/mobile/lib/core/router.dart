import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../features/login/login_screen.dart';
import '../features/approvals/approvals_screen.dart';
import '../features/approvals/approval_detail_screen.dart';
import 'session.dart';

GoRouter buildRouter(WidgetRef ref) => GoRouter(
      initialLocation: '/approvals',
      redirect: (context, state) {
        final loggedIn = ref.read(sessionProvider) != null;
        final onLogin = state.matchedLocation == '/login';
        if (!loggedIn && !onLogin) return '/login';
        if (loggedIn && onLogin) return '/approvals';
        return null;
      },
      routes: [
        GoRoute(path: '/login', builder: (_, __) => const LoginScreen()),
        GoRoute(path: '/approvals', builder: (_, __) => const ApprovalsScreen()),
        GoRoute(path: '/approvals/:id', builder: (_, s) => ApprovalDetailScreen(id: s.pathParameters['id']!)),
      ],
    );

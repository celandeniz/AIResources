import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';
import '../features/approvals/approvals_screen.dart';
import '../features/approvals/approval_detail_screen.dart';
import '../features/inbox/inbox_screen.dart';
import '../features/inbox/activity_detail_screen.dart';
import '../features/dashboard/dashboard_screen.dart';
import '../features/login/login_screen.dart';
import '../features/missions/missions_screen.dart';
import '../features/missions/mission_detail_screen.dart';
import '../features/meetings/meetings_screen.dart';
import '../shell.dart';
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
        ShellRoute(
          builder: (context, state, child) => AppShell(
            currentPath: state.matchedLocation,
            onTab: (path) => GoRouter.of(context).go(path),
            child: child,
          ),
          routes: [
            GoRoute(path: '/approvals', builder: (_, __) => const ApprovalsScreen()),
            GoRoute(path: '/approvals/:id', builder: (_, s) => ApprovalDetailScreen(id: s.pathParameters['id']!)),
            GoRoute(path: '/inbox', builder: (_, __) => const InboxScreen()),
            GoRoute(path: '/inbox/:id', builder: (_, s) => ActivityDetailScreen(id: s.pathParameters['id']!)),
            GoRoute(path: '/chat', builder: (_, __) => const Scaffold(body: Center(child: Text('Sohbet — M2\'de geliyor')))),
            GoRoute(path: '/missions', builder: (_, __) => const MissionsScreen()),
            GoRoute(path: '/missions/:id', builder: (_, s) => MissionDetailScreen(id: s.pathParameters['id']!)),
            GoRoute(path: '/meetings', builder: (_, __) => const MeetingsScreen()),
            GoRoute(path: '/more', builder: (_, __) => const DashboardScreen()),
          ],
        ),
      ],
    );

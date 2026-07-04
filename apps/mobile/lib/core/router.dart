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
import '../features/chat/chat_conversation_screen.dart';
import '../features/chat/chat_threads_screen.dart';
import '../features/operator/operator_detail_screen.dart';
import '../features/operator/operator_screen.dart';
import '../shell.dart';
import 'session.dart';
import '../ui/tokens/tokens.dart';

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
    GoRoute(
      path: '/login',
      pageBuilder: (_, state) => _page(state, const LoginScreen()),
    ),
    ShellRoute(
      builder: (context, state, child) => AppShell(
        currentPath: state.matchedLocation,
        onTab: (path) => GoRouter.of(context).go(path),
        child: child,
      ),
      routes: [
        GoRoute(
          path: '/approvals',
          pageBuilder: (_, state) => _page(state, const ApprovalsScreen()),
        ),
        GoRoute(
          path: '/approvals/:id',
          pageBuilder: (_, state) => _page(
            state,
            ApprovalDetailScreen(id: state.pathParameters['id']!),
          ),
        ),
        GoRoute(
          path: '/inbox',
          pageBuilder: (_, state) => _page(state, const InboxScreen()),
        ),
        GoRoute(
          path: '/inbox/:id',
          pageBuilder: (_, state) => _page(
            state,
            ActivityDetailScreen(id: state.pathParameters['id']!),
          ),
        ),
        GoRoute(
          path: '/chat',
          pageBuilder: (_, state) => _page(state, const ChatThreadsScreen()),
        ),
        GoRoute(
          path: '/chat/:id',
          pageBuilder: (_, state) => _page(
            state,
            ChatConversationScreen(
              threadId: state.pathParameters['id'] == 'new'
                  ? null
                  : state.pathParameters['id'],
              resourceKey: state.uri.queryParameters['resourceKey'] ?? '',
              resourceName: state.uri.queryParameters['resourceName'] ?? 'Sohbet',
            ),
          ),
        ),
        GoRoute(
          path: '/missions',
          pageBuilder: (_, state) => _page(state, const MissionsScreen()),
        ),
        GoRoute(
          path: '/missions/:id',
          pageBuilder: (_, state) => _page(
            state,
            MissionDetailScreen(id: state.pathParameters['id']!),
          ),
        ),
        GoRoute(
          path: '/meetings',
          pageBuilder: (_, state) => _page(state, const MeetingsScreen()),
        ),
        GoRoute(
          path: '/more',
          pageBuilder: (_, state) => _page(state, const DashboardScreen()),
        ),
        GoRoute(
          path: '/operator',
          pageBuilder: (_, state) => _page(state, const OperatorScreen()),
        ),
        GoRoute(
          path: '/operator/commands/:id',
          pageBuilder: (_, state) => _page(
            state,
            OperatorDetailScreen(commandId: state.pathParameters['id']!),
          ),
        ),
      ],
    ),
  ],
);

CustomTransitionPage<void> _page(GoRouterState state, Widget child) =>
    CustomTransitionPage<void>(
      key: state.pageKey,
      transitionDuration: DynMotion.dPage,
      reverseTransitionDuration: DynMotion.dPage,
      child: child,
      transitionsBuilder: (context, animation, secondaryAnimation, child) {
        final curved = CurvedAnimation(
          parent: animation,
          curve: DynMotion.easeOut,
        );
        return FadeTransition(
          opacity: curved,
          child: SlideTransition(
            position: Tween<Offset>(
              begin: const Offset(0, 0.025),
              end: Offset.zero,
            ).animate(curved),
            child: child,
          ),
        );
      },
    );

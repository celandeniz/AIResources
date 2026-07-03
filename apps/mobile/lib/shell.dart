import 'package:flutter/material.dart';

const _tabs = [
  (path: '/approvals', icon: Icons.fact_check_outlined, label: 'Onaylar'),
  (path: '/inbox', icon: Icons.inbox_outlined, label: 'Gelen Kutusu'),
  (path: '/chat', icon: Icons.chat_bubble_outline, label: 'Sohbet'),
  (path: '/missions', icon: Icons.rocket_launch_outlined, label: 'Missionlar'),
  (path: '/more', icon: Icons.grid_view_outlined, label: 'Daha'),
];

class AppShell extends StatelessWidget {
  const AppShell({super.key, required this.child, required this.currentPath, required this.onTab});
  final Widget child;
  final String currentPath;
  final void Function(String path) onTab;

  @override
  Widget build(BuildContext context) {
    final index = _tabs.indexWhere((t) => currentPath.startsWith(t.path)).clamp(0, _tabs.length - 1);
    return Scaffold(
      body: child,
      bottomNavigationBar: NavigationBar(
        selectedIndex: index,
        onDestinationSelected: (i) => onTab(_tabs[i].path),
        destinations: [for (final t in _tabs) NavigationDestination(icon: Icon(t.icon), label: t.label)],
      ),
    );
  }
}

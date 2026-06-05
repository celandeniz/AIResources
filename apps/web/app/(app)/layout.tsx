'use client';
import * as React from 'react';
import { usePathname, useRouter } from 'next/navigation';
import Link from 'next/link';
import { useTheme } from 'next-themes';
import {
  LayoutDashboard, Inbox, Users, CheckSquare, BookOpen, ScrollText, Workflow,
  Plug, Sun, Moon, Bell, Search, ChevronsLeft, LogOut, ChevronDown,
  Building2, UsersRound, ShieldCheck, History, FileText, Repeat, Target, Gauge,
  BarChart3, Sparkles, FileBarChart, ClipboardCheck, PenLine, Code2,
} from 'lucide-react';
import { getToken, getUser, logout, api } from '../../lib/api';
import { CommandPalette } from '../../components/command-palette';
import { WorkspaceProvider, WorkspaceSwitcher } from '../../components/workspace';
import { TooltipProvider, Tooltip, Avatar } from '../../components/ui/misc';
import { Dropdown, DropdownTrigger, DropdownContent, DropdownItem, DropdownLabel, DropdownSeparator } from '../../components/ui/dropdown';
import { cn } from '../../lib/utils';

const SECTIONS = [
  { heading: 'Operate', items: [
    { href: '/inbox', label: 'Activity Inbox', icon: Inbox },
    { href: '/approvals', label: 'Approvals', icon: CheckSquare },
    { href: '/missions', label: 'Mission Pods', icon: Target },
  ]},
  { heading: 'Workforce', items: [
    { href: '/directory', label: 'AI Resources', icon: Users },
    { href: '/workflows', label: 'Workflows', icon: Workflow },
    { href: '/automations', label: 'Automations', icon: Repeat },
    { href: '/knowledge', label: 'Knowledge', icon: BookOpen },
    { href: '/templates', label: 'Templates', icon: FileText },
    { href: '/skills', label: 'Skills', icon: Sparkles },
    { href: '/code-tasks', label: 'Code Tasks', icon: Code2 },
  ]},
  { heading: 'Insights', items: [
    { href: '/', label: 'Dashboard', icon: LayoutDashboard },
    { href: '/performance', label: 'Performance', icon: Gauge },
    { href: '/analyst', label: 'Data Analyst', icon: BarChart3 },
    { href: '/reports', label: 'Reports', icon: FileBarChart },
    { href: '/status-reports', label: 'Project Status', icon: ClipboardCheck },
    { href: '/backtest', label: 'Backtest', icon: History },
    { href: '/audit', label: 'Audit & Logs', icon: ScrollText },
  ]},
  { heading: 'Admin', items: [
    { href: '/settings/style', label: 'Reply Style', icon: PenLine },
    { href: '/settings/integrations', label: 'Integrations', icon: Plug },
    { href: '/settings/workspace', label: 'Workspace', icon: Building2 },
    { href: '/settings/members', label: 'Members', icon: UsersRound },
    { href: '/settings/security', label: 'Security', icon: ShieldCheck },
  ]},
];

export default function AppLayout({ children }: { children: React.ReactNode }) {
  const router = useRouter();
  const pathname = usePathname();
  const { theme, setTheme } = useTheme();
  const [ready, setReady] = React.useState(false);
  const [user, setUser] = React.useState<any>(null);
  const [collapsed, setCollapsed] = React.useState(false);
  const [pending, setPending] = React.useState(0);

  React.useEffect(() => {
    if (!getToken()) { router.replace('/login'); return; }
    setUser(getUser());
    setReady(true);
    api('/approvals?status=pending').then((d: any[]) => setPending(d?.length ?? 0)).catch(() => {});
  }, [router]);

  if (!ready) return null;

  return (
    <WorkspaceProvider>
    <TooltipProvider>
      <CommandPalette />
      <div className="grid min-h-screen" style={{ gridTemplateColumns: collapsed ? '72px 1fr' : '256px 1fr' }}>
        {/* Sidebar */}
        <aside className="sticky top-0 flex h-screen flex-col border-r border-border bg-card/60">
          <div className="px-3 py-3">
            <WorkspaceSwitcher collapsed={collapsed} />
          </div>

          <nav className="flex-1 space-y-5 overflow-auto px-3 py-2">
            {SECTIONS.map((s) => (
              <div key={s.heading}>
                {!collapsed && <div className="px-2 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-muted-foreground/70">{s.heading}</div>}
                <div className="space-y-0.5">
                  {s.items.map((n) => {
                    const active = n.href === '/' ? pathname === '/' : pathname.startsWith(n.href);
                    const link = (
                      <Link key={n.href} href={n.href}
                        className={cn(
                          'group flex items-center gap-3 rounded-lg px-2.5 py-2 text-sm transition-colors duration-150 ease-out',
                          active ? 'bg-primary/10 text-primary font-medium' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                          collapsed && 'justify-center',
                        )}
                      >
                        <n.icon className={cn('size-[18px] shrink-0', active && 'text-primary')} />
                        {!collapsed && <span className="truncate">{n.label}</span>}
                        {!collapsed && n.href === '/approvals' && pending > 0 && (
                          <span className="ml-auto rounded-full bg-warning/15 px-1.5 text-[10px] font-semibold text-warning">{pending}</span>
                        )}
                      </Link>
                    );
                    return collapsed ? <Tooltip key={n.href} content={n.label}>{link}</Tooltip> : link;
                  })}
                </div>
              </div>
            ))}
          </nav>

          <button onClick={() => setCollapsed((c) => !c)} className="m-3 flex items-center justify-center gap-2 rounded-lg border border-border px-2 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/60">
            <ChevronsLeft className={cn('size-4 transition-transform', collapsed && 'rotate-180')} />
            {!collapsed && 'Collapse'}
          </button>
        </aside>

        {/* Main */}
        <div className="flex min-w-0 flex-col">
          {/* Topbar */}
          <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/80 px-6 backdrop-blur-md">
            <button
              onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
              className="flex h-9 w-72 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm text-muted-foreground shadow-xs transition-colors hover:bg-muted/40"
            >
              <Search className="size-4" />
              <span>Search or run a command…</span>
              <kbd className="ml-auto rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
            </button>

            <div className="ml-auto flex items-center gap-1.5">
              <Tooltip content="Notifications">
                <Link href="/notifications" className="relative grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
                  <Bell className="size-[18px]" />
                  {pending > 0 && <span className="absolute right-2 top-2 size-2 rounded-full bg-warning ring-2 ring-background" />}
                </Link>
              </Tooltip>
              <Tooltip content="Toggle theme">
                <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} className="grid size-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground">
                  <Sun className="size-[18px] dark:hidden" />
                  <Moon className="hidden size-[18px] dark:block" />
                </button>
              </Tooltip>
              <Dropdown>
                <DropdownTrigger asChild>
                  <button className="flex items-center gap-2 rounded-lg py-1 pl-1 pr-2 transition-colors hover:bg-muted/60">
                    <Avatar name={user?.email} />
                    <ChevronDown className="size-3.5 text-muted-foreground" />
                  </button>
                </DropdownTrigger>
                <DropdownContent>
                  <DropdownLabel>{user?.email}</DropdownLabel>
                  <div className="px-2.5 pb-1.5 text-xs text-muted-foreground capitalize">{user?.role} · DynamicsOps</div>
                  <DropdownSeparator />
                  <DropdownItem onSelect={() => { logout(); router.replace('/login'); }} className="text-danger focus:bg-danger/10">
                    <LogOut className="size-4" />Sign out
                  </DropdownItem>
                </DropdownContent>
              </Dropdown>
            </div>
          </header>

          <main className="grain min-h-[calc(100vh-3.5rem)] flex-1 overflow-auto px-6 py-7 mesh">
            <div className="mx-auto w-full max-w-[1240px] animate-fade-up">{children}</div>
          </main>
        </div>
      </div>
    </TooltipProvider>
    </WorkspaceProvider>
  );
}

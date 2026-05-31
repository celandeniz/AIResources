'use client';
import * as React from 'react';
import { Command } from 'cmdk';
import { useRouter } from 'next/navigation';
import { useTheme } from 'next-themes';
import { DialogTitle } from '@radix-ui/react-dialog';
import {
  LayoutDashboard, Inbox, Users, CheckSquare, BookOpen, ScrollText, Workflow,
  Plug, Sun, Moon, Mail, Search, Bell, FileText,
} from 'lucide-react';
import { api } from '../lib/api';
import { toast } from './ui/toaster';

const NAV = [
  { label: 'Dashboard', href: '/', icon: LayoutDashboard },
  { label: 'Activity Inbox', href: '/inbox', icon: Inbox },
  { label: 'AI Resource Directory', href: '/directory', icon: Users },
  { label: 'Approval Center', href: '/approvals', icon: CheckSquare },
  { label: 'Knowledge Base', href: '/knowledge', icon: BookOpen },
  { label: 'Templates', href: '/templates', icon: FileText },
  { label: 'Notifications', href: '/notifications', icon: Bell },
  { label: 'Workflows', href: '/workflows', icon: Workflow },
  { label: 'Audit & Logs', href: '/audit', icon: ScrollText },
  { label: 'Integrations', href: '/settings/integrations', icon: Plug },
];

export function CommandPalette() {
  const [open, setOpen] = React.useState(false);
  const router = useRouter();
  const { theme, setTheme } = useTheme();

  React.useEffect(() => {
    const down = (e: KeyboardEvent) => {
      if (e.key === 'k' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    document.addEventListener('keydown', down);
    return () => document.removeEventListener('keydown', down);
  }, []);

  const go = (href: string) => { setOpen(false); router.push(href); };
  const run = async (fn: () => Promise<any>, msg: string) => {
    setOpen(false);
    try { await fn(); toast.success(msg); } catch (e: any) { toast.error(e.message); }
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      className="fixed left-1/2 top-[18%] z-50 w-full max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-popover shadow-lg outline-none data-[state=open]:animate-fade-up"
    >
      <DialogTitle className="sr-only">Command palette</DialogTitle>
      <div className="flex items-center gap-2 border-b border-border px-4">
        <Search className="size-4 text-muted-foreground" />
        <Command.Input placeholder="Search or run a command…" className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
        <kbd className="rounded border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">ESC</kbd>
      </div>
      <Command.List className="max-h-80 overflow-auto p-2">
        <Command.Empty className="py-8 text-center text-sm text-muted-foreground">No results.</Command.Empty>
        <Command.Group heading="Navigate" className="px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
          {NAV.map((n) => (
            <Item key={n.href} onSelect={() => go(n.href)}><n.icon className="size-4 text-muted-foreground" />{n.label}</Item>
          ))}
        </Command.Group>
        <Command.Group heading="Actions" className="mt-1 px-1 text-[11px] font-medium uppercase tracking-wide text-muted-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5">
          <Item onSelect={() => run(() => api('/activities/trigger-mock-email', { method: 'POST' }), 'Mock email ingested')}>
            <Mail className="size-4 text-muted-foreground" />Trigger mock email
          </Item>
          <Item onSelect={() => { setTheme(theme === 'dark' ? 'light' : 'dark'); setOpen(false); }}>
            {theme === 'dark' ? <Sun className="size-4 text-muted-foreground" /> : <Moon className="size-4 text-muted-foreground" />}
            Toggle {theme === 'dark' ? 'light' : 'dark'} theme
          </Item>
        </Command.Group>
      </Command.List>
    </Command.Dialog>
  );
}

function Item({ children, onSelect }: { children: React.ReactNode; onSelect: () => void }) {
  return (
    <Command.Item
      onSelect={onSelect}
      className="flex cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2.5 text-sm outline-none data-[selected=true]:bg-muted"
    >
      {children}
    </Command.Item>
  );
}

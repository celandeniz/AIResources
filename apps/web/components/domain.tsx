'use client';
import * as React from 'react';
import { Badge } from './ui/badge';
import { cn } from '../lib/utils';
import {
  Mail, MessageSquare, Calendar, GitBranch, Github, Building2, Database,
  FileText, Ticket, Hand, Inbox as InboxIcon, Phone,
} from 'lucide-react';

/* Status → badge variant + label */
const STATUS_MAP: Record<string, { v: any; label: string }> = {
  new: { v: 'neutral', label: 'New' },
  watching: { v: 'neutral', label: 'Watching' },
  triaging: { v: 'default', label: 'Triaging' },
  routed: { v: 'default', label: 'Routed' },
  in_progress: { v: 'default', label: 'In progress' },
  awaiting_approval: { v: 'warning', label: 'Awaiting approval' },
  completed: { v: 'success', label: 'Completed' },
  escalated: { v: 'danger', label: 'Escalated' },
  failed: { v: 'danger', label: 'Failed' },
  archived: { v: 'neutral', label: 'Archived' },
  pending: { v: 'warning', label: 'Pending' },
  approved: { v: 'success', label: 'Approved' },
  rejected: { v: 'danger', label: 'Rejected' },
  succeeded: { v: 'success', label: 'Succeeded' },
  awaiting: { v: 'warning', label: 'Awaiting' },
};

export function StatusBadge({ status }: { status: string }) {
  const m = STATUS_MAP[status] ?? { v: 'neutral', label: status };
  return (
    <Badge variant={m.v}>
      <span className={cn('size-1.5 rounded-full', m.v === 'success' && 'bg-success', m.v === 'warning' && 'bg-warning', m.v === 'danger' && 'bg-danger', (m.v === 'default') && 'bg-primary', m.v === 'neutral' && 'bg-muted-foreground/50')} />
      {m.label}
    </Badge>
  );
}

export const CHANNEL_ICON: Record<string, React.ComponentType<any>> = {
  email: Mail, teams: MessageSquare, calendar: Calendar, devops: GitBranch,
  github: Github, opsconnect: Building2, business_central: Database,
  crm: Database, erp: Database, sharepoint: FileText, ticket: Ticket,
  document: FileText, manual: Hand, whatsapp: Phone,
};

export function ChannelChip({ channel }: { channel: string }) {
  const Icon = CHANNEL_ICON[channel] ?? Hand;
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground">
      <Icon className="size-3" />
      {channel}
    </span>
  );
}

/* Signature: confidence dial (radial arc, threshold-colored) */
export function ConfidenceDial({ value, size = 64, threshold = 0.72 }: { value: number | null | undefined; size?: number; threshold?: number }) {
  const v = typeof value === 'number' ? Math.max(0, Math.min(1, value)) : 0;
  const r = (size - 8) / 2;
  const c = 2 * Math.PI * r;
  const color = v < 0.5 ? 'hsl(var(--danger))' : v < threshold ? 'hsl(var(--warning))' : 'hsl(var(--success))';
  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg width={size} height={size} className="-rotate-90">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="hsl(var(--muted))" strokeWidth={4} />
        <circle
          cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={4} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - v)} style={{ transition: 'stroke-dashoffset 0.6s cubic-bezier(0.22,1,0.36,1)' }}
        />
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center">
        <span className="font-mono text-sm font-semibold tnum" style={{ color }}>{value == null ? '—' : Math.round(v * 100)}</span>
        <span className="text-[9px] uppercase tracking-wide text-muted-foreground">conf</span>
      </div>
    </div>
  );
}

export function EmptyState({ icon: Icon = InboxIcon, title, hint, action }: { icon?: React.ComponentType<any>; title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed border-border py-16 text-center">
      <div className="grid size-12 place-items-center rounded-xl bg-muted/60 text-muted-foreground">
        <Icon className="size-6" />
      </div>
      <div>
        <p className="font-medium">{title}</p>
        {hint && <p className="mt-1 text-sm text-muted-foreground">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

export function SectionTitle({ children, right }: { children: React.ReactNode; right?: React.ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between">
      <h2 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-muted-foreground">{children}</h2>
      {right}
    </div>
  );
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex items-start justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl tracking-tight text-balance">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted-foreground">{subtitle}</p>}
      </div>
      {actions && <div className="flex items-center gap-2">{actions}</div>}
    </div>
  );
}
